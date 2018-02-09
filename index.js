'use strict'

// imports
const debug = require('debug')('ilp-plugin-xrp-paychan')
const BtpPacket = require('btp-packet')
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
const {
  ChannelWatcher,
  util
} = require('ilp-plugin-xrp-paychan-shared')

// constants
const CHANNEL_KEYS = 'ilp-plugin-xrp-paychan-channel-keys'
const DEFAULT_CHANNEL_AMOUNT = 1000000
const DEFAULT_BANDWIDTH = 2000
const DEFAULT_FUND_THRESHOLD = 0.9

class PluginXrpPaychan extends PluginBtp {
  constructor (opts) {
    super(opts)

    this._xrpServer = opts.xrpServer || opts.rippledServer // TODO: deprecate rippledServer
    this._api = new RippleAPI({ server: this._xrpServer })
    this._secret = opts.secret
    this._address = opts.address || deriveAddress(deriveKeypair(this._secret).publicKey)

    this._peerAddress = opts.peerAddress // TODO: try to get this over the paychan?
    this._bandwidth = opts.maxUnsecured || DEFAULT_BANDWIDTH
    this._fundThreshold = opts.fundThreshold || DEFAULT_FUND_THRESHOLD
    this._channelAmount = opts.channelAmount || DEFAULT_CHANNEL_AMOUNT
    this._claimInterval = opts.claimInterval || util.DEFAULT_CLAIM_INTERVAL
    this._settleDelay = opts.settleDelay || util.MIN_SETTLE_DELAY

    const keyPairSeed = util.hmac(this._secret, CHANNEL_KEYS + this._peerAddress)
    this._keyPair = nacl.sign.keyPair.fromSeed(keyPairSeed)

    this._store = new StoreWrapper(opts._store)
    this._outgoingChannel = null
    this._incomingChannel = null
    this._incomingChannelDetails = null
    this._incomingClaim = null
    this._outgoingClaim = null

    this._watcher = new ChannelWatcher(60 * 1000, this._api)
    this._watcher.on('channelClose', () => {
      debug('channel closing; triggering auto-disconnect')
      // TODO: should we also close our own channel?
      this.disconnect()
    })
  }

  async _handleData (from, { requestId, data }) {
    const { ilp, protocolMap } = this.protocolDataToIlpAndCustom(data)

    if (protocolMap.ripple_channel_id) {
      this._incomingChannel = protocolMap.ripple_channel_id
      await this._reloadIncomingChannelDetails()

      return [{
        protocolName: 'ripple_channel_id',
        contentType: BtpPacket.MIME_TEXT_PLAIN_UTF8,
        data: Buffer.from(this._outgoingChannel)
      }]
    }

    if (!this._dataHandler) {
      throw new Error('no request handler registered')
    }

    const response = await this._dataHandler(ilp)
    return this.ilpAndCustomToProtocolData({ ilp: response })
  }

  async _reloadIncomingChannelDetails () {
    if (!this._incomingChannel) {
      debug('quering peer for incoming channel id')
      try {
        const response = await this._call(null, {
          type: BtpPacket.TYPE_MESSAGE,
          requestId: await util._requestId(),
          data: { protocolData: [{
            protocolName: 'ripple_channel_id',
            contentType: BtpPacket.MIME_TEXT_PLAIN_UTF8,
            data: Buffer.from(this._outgoingChannel)
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
      this._incomingChannelDetails = await this._api.getPaymentChannel(this._incomingChannel)
      debug('incoming channel details are:', this._incomingChannelDetails)
    } catch (err) {
      if (err.name === 'RippledError' && err.message === 'entryNotFound') {
        debug('incoming payment channel does not exist:', this._incomingChannel)
      } else {
        debug(err)
      }
      return
    }

    // Make sure the watcher has enough time to submit the best
    // claim before the channel closes
    const settleDelay = this._incomingChannelDetails.settleDelay
    if (settleDelay < util.MIN_SETTLE_DELAY) {
      debug(`incoming payment channel has a too low settle delay of ${settleDelay.toString()}
        seconds. Minimum settle delay is ${util.MIN_SETTLE_DELAY} seconds.`)
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

    this._lastClaimedAmount = new BigNumber(util.xrpToDrops(this._incomingChannelDetails.balance))
    this._claimIntervalId = setInterval(async () => {
      if (this._lastClaimedAmount.isLessThan(this._incomingClaim.amount)) {
        debug('starting automatic claim. amount=' + this._incomingClaim.amount)
        this._lastClaimedAmount = new BigNumber(this._incomingClaim.amount)
        await this._claimFunds()
        debug('claimed funds.')
      }
    }, this._claimInterval)
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
    this._incomingClaim = JSON.parse(this._store.get('incoming_claim') || '{"amount":"0"}')
    this._outgoingClaim = JSON.parse(this._store.get('outgoing_claim') || '{"amount":"0"}')
    debug('loaded incoming claim:', this._incomingClaim)

    if (!this._outgoingChannel) {
      debug('creating new payment channel')

      const txTag = util.randomTag()
      const tx = await this._api.preparePaymentChannelCreate(this._address, {
        amount: util.dropsToXrp(this._channelAmount),
        destination: this._peerAddress,
        settleDelay: this._settleDelay,
        publicKey: 'ED' + Buffer.from(this._keyPair.publicKey).toString('hex').toUpperCase(),
        sourceTag: txTag
      })

      debug('created paymentChannelCreate tx', tx.txJSON)

      const signedTx = this._api.sign(tx.txJSON, this._secret)
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
        const handleTransaction = (ev) => {
          if (ev.transaction.SourceTag !== txTag) return
          if (ev.transaction.Account !== this._address) return

          this._outgoingChannel = util.computeChannelId(
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
      debug('payment channel successfully created: ', this._outgoingChannel)
    }

    this._outgoingChannelDetails = await this._api.getPaymentChannel(this._outgoingChannel)
    await this._reloadIncomingChannelDetails()
  }

  async _claimFunds () {
    if (!this._incomingClaim.signature) {
      return
    }

    const tx = await this._api.preparePaymentChannelClaim(this._address, {
      balance: util.dropsToXrp(this._incomingClaim.amount),
      channel: this._incomingChannel,
      signature: this._incomingClaim.signature.toUpperCase(),
      publicKey: this._incomingChannelDetails.publicKey
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

        if (ev.engine_result === 'tesSUCCESS') {
          debug('successfully submitted claim', this._incomingClaim)
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
    clearInterval(this._claimIntervalId)
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

  async sendMoney (amount) {
    const claimAmount = new BigNumber(this._outgoingClaim.amount).plus(amount)
    const encodedClaim = util.encodeClaim(claimAmount, this._outgoingChannel)
    const signature = nacl.sign.detached(encodedClaim, this._keyPair.secretKey)

    debug(`signed outgoing claim for ${claimAmount.toString()} drops on
      channel ${this._outgoingChannel}`)

    if (!this._funding && claimAmount.isGreaterThan(new BigNumber(util.xrpToDrops(this._outgoingChannelDetails.amount)).times(this._fundThreshold))) {
      this._funding = true
      util.fundChannel({
        api: this._api,
        channel: this._outgoingChannel,
        amount: this._channelAmount,
        address: this._address,
        secret: this._secret
      })
        .then(() => {
          this._funding = false
        })
        .catch((e) => {
          this._funding = false
          debug('error issuing fund tx:', e)
        })
    }

    this._outgoingClaim = {
      amount: claimAmount.toString(),
      signature: Buffer.from(signature).toString('hex')
    }
    this._store.set('outgoing_claim', JSON.stringify(this._outgoingClaim))

    await this._call(null, {
      type: BtpPacket.TYPE_TRANSFER,
      requestId: await util._requestId(),
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

  async _handleMoney (from, { requestId, data }) {
    const amount = data.amount
    const protocolData = data.protocolData
    const claim = JSON.parse(protocolData
      .filter(p => p.protocolName === 'claim')[0]
      .data
      .toString())

    const claimAmount = new BigNumber(claim.amount)
    const encodedClaim = util.encodeClaim(claim.amount, this._incomingChannel)
    const addedMoney = claimAmount.minus(this._incomingClaim.amount)

    if (addedMoney.lte(0)) {
      throw new Error('new claim is less than old claim. new=' + claim.amount +
        ' old=' + this._incomingClaim.amount)
    }

    // Don't throw an error here; we'll just emit the addedMoney amount and keep going.
    // This can happen during high throughput when transfers may get out of sync with
    // settlements. So long as one peer doesn't crash before balances are written, the
    // discrepency should go away automatically.
    if (!addedMoney.isEqualTo(amount)) {
      debug('warning: peer balance is out of sync with ours. peer thinks they sent ' +
        amount + '; we got ' + addedMoney.toString())
    }

    debug(`received claim for ${addedMoney.toString()} drops on channel ${this._incomingChannel}`)

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
        ${claimAmount.toString()} drops total`)
      throw new Error('got invalid claim signature ' +
        claim.signature + ' for amount ' + claimAmount.toString() +
        ' drops total')
    }

    // validate claim against balance
    const channelAmount = util.xrpToDrops(this._incomingChannelDetails.amount)
    if (claimAmount.isGreaterThan(channelAmount)) {
      const message = `got claim for amount higher than channel balance. amount:
        ${claimAmount.toString()} incoming channel amount: ${channelAmount}`
      debug(message)
      throw new Error(message)
    }

    this._incomingClaim = {
      amount: claimAmount.toString(),
      signature: claim.signature.toUpperCase()
    }
    this._store.set('incoming_claim', JSON.stringify(this._incomingClaim))

    if (this._moneyHandler) {
      await this._moneyHandler(addedMoney.toString())
    }

    return []
  }
}

PluginXrpPaychan.version = 2
module.exports = PluginXrpPaychan
