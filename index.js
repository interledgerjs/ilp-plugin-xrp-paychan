'use strict'

// imports
const { RippleAPI } = require('ripple-lib')
const { deriveAddress, deriveKeypair } = require('ripple-keypairs')
const addressCodec = require('ripple-address-codec')
const PluginBtp = require('ilp-plugin-btp')
const uuid = require('uuid')
const nacl = require('tweetnacl')
const crypto = require('crypto')
const bignum = require('bignum') // required in order to convert to buffer
const BigNumber = require('bignumber.js')
const assert = require('assert')
const moment = require('moment')
const StoreWrapper = require('./store-wrapper')

// constants
const CHANNEL_KEYS = 'ilp-plugin-xrp-paychan-channel-keys'
const DEFAULT_CHANNEL_AMOUNT = 1000000
const DEFAULT_BANDWIDTH = 2000
const DEFAULT_REFUND_THRESHOLD = 0.9
const {
  DEFAULT_WATCHER_INTERVAL,
  STATE_NO_CHANNEL,
  STATE_CREATING_CHANNEL,
  STATE_CHANNEL,
  POLLING_INTERVAL_OUTGOING_PAYCHAN,
  MIN_SETTLE_DELAY,
  xrpToDrops,
  dropsToXrp,
  sleep
} = require('./src/lib/constants')

// utility functions
const randomTag = () => bignum.fromBuffer(crypto.randomBytes(4), {
  endian: 'big',
  size: 4
}).toNumber()

const encodeClaim = (amount, id) => Buffer.concat([
  Buffer.from('CLM\0'),
  Buffer.from(id, 'hex'),
  bignum(amount).toBuffer({
    endian: 'big',
    size: 8
  })
])

const computeChannelId = (src, dest, sequence) => {
  const preimage = Buffer.concat([
    Buffer.from('\0x', 'ascii'),
    Buffer.from(addressCodec.decodeAccountID(src)),
    Buffer.from(addressCodec.decodeAccountID(dest)),
    bignum(sequence).toBuffer({ endian: 'big', size: 4 })
  ])

  return crypto.createHash('sha512')
    .update(preimage)
    .digest()
    .slice(0, 32) // first half sha512
    .toString('hex')
    .toUpperCase()
}

function validateOpts (opts) {
  // TODO: validate plugin options
  // mandatory
  assert(opts.rippledServer, 'rippledServer is required')
  assert(opts.address, 'address is required')
  assert(opts.secret, 'secret is required')
  assert(opts.peerAddress, 'peerAddress is required')
  assert(opts.maxAmount, 'maxAmount is required')
  assert(opts.maxUnsecured, 'maxUnsecured is required')

  // optional
  if (opts.fundThreshold) {
    assert(parseFloat(opts.fundThreshold) > 0 && parseFloat(opts.fundThreshold) <= 1)
  }
}

function hmac (key, message) {
  const h = crypto.createHmac('sha256', key)
  h.update(message)
  return h.digest()
}

module.exports = class PluginXrpPaychan extends PluginBtp {
  constructor (opts) {
    super(opts)
    
    this._rippledServer = opts.rippledServer // TODO: can default here?
    this._api = new RippleAPI({ server: opts.rippledServer })
    this._secret = opts.secret
    this._address = opts.address || deriveAddress(deriveKeypair(this._secret).publicKey)

    this._peerAddress = opts.peerAddress // TODO: try to get this over the paychan?
    this._bandwidth = opts.maxUnsecured || DEFAULT_BANDWIDTH
    this._fundThreshold = opts.fundThreshold || DEFAULT_FUND_THRESHOLD
    this._channelAmount = opts.channelAmount || DEFAULT_CHANNEL_AMOUNT

    this._prefix = opts.prefix // TODO: shouldn't be needed at all
    this._settleDelay = opts.settleDelay || MIN_SETTLE_DELAY

    const keyPairSeed = hmac(this._secret, CHANNEL_KEYS + this._peerAddress)
    this._keyPair = nacl.sign.keyPair.fromSeed(keyPairSeed)

    this._store = new StoreWrapper(opts.store)
    this._outgoingChannel = null
    this._incomingChannel = null
    this._incomingChannelDetails = null
    this._incomingClaim = null
    this._outgoingClaim = null

    // TODO: handle incoming channel ID method
  }

  async _reloadIncomingChannelDetails () {
    if (!this._incomingChannel) {
      debug('quering peer for incoming channel id')
      try {
        const response = await this._call(null, {
          type: BtpPacket.MESSAGE,
          requestId: await _requestId(),
          data: { protocolData: [{
            protocolName: 'ripple_channel_id',
            contentType: BtpPacket.MIME_APPLICATION_JSON,
            data: Buffer.from(JSON.stringify([]))
          }] }
        })

        // TODO: should this send raw bytes instead of text in the future
        debug('got ripple_channel_id response:', response)
        this._incomingChannel = response
          .protocolData
          .filter(p => p.protocolName === 'ripple_channel_id')[0]
          .data
          .toString()
        this._store.set('incoming_channel', this._incomingChannel)
      } catch (err) { debug(err) }

      if (!this._incomingChannel) {
        debug('cannot load incoming channel. Peer did not return incoming channel id')
        return
      }
    }

    // look up channel on ledger
    debug('retrieving details for incoming channel', this._incomingChannel)
    try {
      this._incomingChannelDetails = await this._api.getPaymentChannel(chanId)
      debug('incoming channel details are:', incomingChan)
    } catch (err) {
      if (err.name === 'RippledError' && err.message === 'entryNotFound') {
        debug('incoming payment channel does not exist:', chanId)
      } else {
        debug(err)
      }
      return
    }

    // Make sure the watcher has enough time to submit the best
    // claim before the channel closes
    const settleDelay = this._incomingChannelDetails.settleDelay
    if (settleDelay < MIN_SETTLE_DELAY) {
      debug(`incoming payment channel has a too low settle delay of ${settleDelay.toString()}
        seconds. Minimum settle delay is ${MIN_SETTLE_DELAY} seconds.`)
      throw new Error('settle delay of incoming payment channel too low')
    }

    if (this._incomingChannelDetails.cancelAfter) {
      debug(`channel has cancelAfter set`)
      throw new Error('cancelAfter must not be set')
    }

    if (this._incomingChannelDetails.expiration) {
      debug(`channel has expiration set`)
      throw new Error('expiration must not be set')
    }

    if (this._incomingChannelDetails.destination !== this._address) {
      debug('incoming channel destination is not our address: ' +
        this._incomingChannelDetails.destination)
      throw new Error('Channel destination address wrong')
    }
  }

  // run after connections are established, but before connect resolves
  async _connect () {
    debug('connecting to rippled')
    await this._api.connect()
    await this._api.connection.request({
      command: 'subscribe',
      accounts: [ this._address, this._peerAddress ]
    })
    debug('connected to rippled')

    await this._store.load('outgoing_channel')
    await this._store.load('incoming_claim')
    await this._store.load('outgoing_claim')

    this._outgoingChannel = this._store.get('outgoing_channel')
    this._incomingClaim = this._store.get('incoming_claim')
    this._outgoingClaim = this._store.get('outgoing_claim') || { amount: '0' }

    if (!this._outgoingChannel) {
      debug('creating new payment channel')

      const tx = await this._api.preparePaymentChannelCreate(this._address, {
        amount: dropsToXrp(this._channelAmount),
        destination: this._peerAddress,
        settleDelay: this._settleDelay,
        publicKey: 'ED' + Buffer.from(this._keyPair.publicKey).toString('hex').toUpperCase(),
        sourceTag: txTag
      })

      debug('created paymentChannelCreate tx', tx.txJSON)

      const signedTx = this.api.sign(tx.txJSON, this._secret)
      let resultCode
      let resultMessage
      try {
        const result = await this._api.submit(signedTx.signedTransaction)
        resultCode = result.resultCode
        resultMessage = result.resultMessage
      } catch (err) {
        debug('error submitting paymentChannelCreate', err)
        throw err
      }
      if (resultCode !== 'tesSUCCESS') {
        const message = 'Error creating the payment channel: ' + resultCode + ' ' + resultMessage
        debug(message)
        throw new Error(message)
      }

      debug('submitted paymentChannelCreate, waiting for tx to be validated (this may take a few seconds)')
      await new Promise((resolve) => {
        function handleTransaction (ev) {
          if (ev.transaction.SourceTag !== txTag) return
          if (ev.transaction.Account !== this._address) return

          this._outgoingChannel = computeChannelId(
            ev.transaction.Account,
            ev.transaction.Destination,
            ev.transaction.Sequence)
          this._store.set('outgoing_channel', this._outgoingChannel)

          setImmediate(() => this._api.connection
            .removeListener('transaction', handleTransaction))
          resolve()
        }

        this._api.connection.on('transaction', handleTransaction)
      })
      debug('payment channel successfully created: ', channelId)
    }

    this._outgoingChannelDetails = await this._api.getPaymentChannel(this._outgoingChannel)
    await this._reloadIncomingChannelDetails()
  }

  async _claimFunds () {
    const tx = await this._api.preparePaymentChannelClaim(this._address, {
      balance: dropsToXrp(this._incomingClaim.amount),
      channel: this._incomingChannel,
      signature: this.incomingClaim.signature.toUpperCase(),
      publicKey: this.incomingChannelDetails.publicKey
    })

    const signedTx = this._api.sign(tx.txJSON, this._secret)
    debug('submitting claim transaction ', tx)
    const {resultCode, resultMessage} = await this._api.submit(signedTx.signedTransaction)
    if (resultCode !== 'tesSUCCESS') {
      debug('Error submitting claim: ', resultMessage)
      throw new Error('Could not claim funds: ', resultMessage)
    }

    return new Promise((resolve) => {
      const handleTransaction = (ev) => {
        if (ev.transaction.Account !== this._address) return
        if (ev.transaction.Channel !== this._incomingChannel) return
        if (ev.transaction.Balance !== amount) return

        if (ev.engine_result === 'tesSUCCESS') {
          debug('successfully submitted claim', signature, 'for amount', amount)
        } else {
          debug('claiming funds failed ', ev)
        }

        setImmediate(() => this._api.connection
          .removeListener('transaction', handleTransaction))
        resolve()
      }
      this._api.connection.on('transaction', handleTransaction)
    })
  }

  async _disconnect () {
    debug('disconnecting payment channel')
    try {
      await this._claimFunds()
    } catch (e) {
      debug('claim error on disconnect:', e)
    }

    try {
      this._api.disconnect()
    } catch (e) {
      debug('error disconnecting from rippled:', e)
    }
  }

  async _fund () {
    debug('outgoing channel threshold reached, adding more funds')
    const xrpAmount = dropsToXrp(this._channelAmount)
    const tx = await this._api.preparePaymentChannelFund(this._address, {
      amount: xrpAmount,
      channel: this._outgoingChannel
    })

    debug('submitting channel fund tx', tx)
    const signedTx = this._api.sign(tx.txJSON, this._secret)
    const { resultCode, resultMessage } = await this._api.submit(signedTx.signedTransaction)
    if (resultCode !== 'tesSUCCESS') {
      debug(`Failed to add ${xrpAmount} XRP to channel ${this._outgoingChannel}: `, resultMessage)
    }

    const handleTransaction = async (ev) => {
      if (ev.transaction.hash !== signedTx.id) return

      if (ev.engine_result === 'tesSUCCESS') {
        debug(`successfully funded channel for ${xrpAmount} XRP`)
        this._outgoingChannelDetails = await this._api.getPaymentChannel(this._outgoingChannel)
      } else {
        debug('funding channel failed ', ev)
      }

      setImmediate(() => this._api.connection
        .removeListener('transaction', handleTransaction))
    }

    this._api.connection.on('transaction', handleTransaction)
  }

  async sendMoney (amount) {
    const claimAmount = new BigNumber(this._outgoingClaim.amount).add(amount)
    const encodedClaim = encodeClaim(claimAmount, this._outgoingChannel)
    const signature = nacl.sign.detached(encodedClaim, this._keyPair.secretKey)

    debug(`signed outgoing claim for ${claimAmount.toString()} drops on
      channel ${this._outgoingChannel}`)

    if (claimAmount.greaterThan(new BigNumber(this._outgoingChannelDetails.amount).times(this._fundThreshold))) {
      this._fund()
        .catch((e) => {
          debug('error issuing fund tx:', e)
        })
    }

    this._outgoingClaim = {
      amount: claimAmount.toString(),
      signature: Buffer.from(signature).toString('hex')
    }
    this._store.set('outgoing_claim', JSON.stringify(this._outgoingClaim))

    await this._call(null, {
      type: BtpPacket.TRANSFER,
      requestId: await _requestId(),
      data: {
        amount,
        protocolData: [{
          protocolName: 'claim',
          contentType: BtpPacket.MIME_APPLICATION_JSON,
          data: Buffer.from(JSON.stringify(this._outgoingClaim))
        }]
      }
    })
  }

  async _handleMoney (from, { amount, protocolData }) {
    const newAmount = new BigNumber(this._incomingClaim.amount).add(amount)
    const encodedClaim = encodeClaim(newAmount.toString(), this._incomingChannel)
    const claim = JSON.parse(protocolData
      .filter(p => p.protocolName === 'claim')[0]
      .data
      .toString())

    debug(`received claim for ${claim.amount} drops on channel ${this._incomingChannel}`)

    let valid = false
    try {
      valid = nacl.sign.detached.verify(
        encodedClaim,
        Buffer.from(claim.signature, 'hex'),
        Buffer.from(this._incomingChannelDetails.publicKey.substring(2), 'hex')
      )
    } catch (err) {
      debug('verifying signature failed:', err.message)
    }

    // TODO: better reconciliation if claims are invalid
    if (!valid) {
      debug(`got invalid claim signature ${claim.signature} for amount
        ${newAmount.toString()} drops`)
      throw new Error('got invalid claim signature ' +
        signature + ' for amount ' + newAmount.toString() + ' drops')
    }

    // validate claim against balance
    const channelBalance = xrpToDrops(this._incomingChannelDetails.amount)
    if (newAmount.greaterThan(channelBalance)) {
      const message = `got claim for amount higher than channel balance. amount:
        ${amount} incoming channel balance: ${channelBalance}`
      debug(message)
      throw new Error(message)
    }

    this._incomingClaim = {
      amount: newAmount,
      signature: claim.signature.toUpperCase()
    }
    this._store.set('incoming_claim', JSON.stringify(this._incomingClaim))

    await this._moneyHandler(amount)
    return []
  }
}
