'use strict'

// imports
const debug = require('debug')('ilp-plugin-xrp-paychan')
const BtpPacket = require('btp-packet')
const { RippleAPI } = require('ripple-lib')
const { deriveAddress, deriveKeypair } = require('ripple-keypairs')
const PluginBtp = require('ilp-plugin-btp')
const nacl = require('tweetnacl')
const BigNumber = require('bignumber.js')
const StoreWrapper = require('./store-wrapper')
const {
  createSubmitter,
  ChannelWatcher,
  util
} = require('ilp-plugin-xrp-paychan-shared')

// constants
const CHANNEL_KEYS = 'ilp-plugin-xrp-paychan-channel-keys'
const DEFAULT_CHANNEL_AMOUNT_XRP = 1
const DEFAULT_FUND_THRESHOLD = 0.5

class PluginXrpPaychan extends PluginBtp {
  constructor (opts) {
    super(opts)

    this._xrpServer = opts.xrpServer || opts.rippledServer // TODO: deprecate rippledServer
    this._api = new RippleAPI({ server: this._xrpServer })
    this._secret = opts.secret
    this._address = opts.address || deriveAddress(deriveKeypair(this._secret).publicKey)
    this._txSubmitter = createSubmitter(this._api, this._address, this._secret)
    this._maxFeePercent = opts.maxFeePercent || 0.01

    if (opts.assetScale && opts.currencyScale) {
      throw new Error('opts.assetScale is an alias for opts.currencyScale;' +
        'only one must be specified')
    }

    const currencyScale = opts.assetScale || opts.currencyScale

    if (typeof currencyScale !== 'number' && currencyScale !== undefined) {
      throw new Error('currency scale must be a number if specified.' +
        ' type=' + (typeof currencyScale) +
        ' value=' + currencyScale)
    }

    this._currencyScale = (typeof currencyScale === 'number') ? currencyScale : 6

    this._peerAddress = opts.peerAddress // TODO: try to get this over the paychan?
    this._fundThreshold = opts.fundThreshold || DEFAULT_FUND_THRESHOLD
    this._channelAmount = opts.channelAmount || this.xrpToBase(DEFAULT_CHANNEL_AMOUNT_XRP)
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
    this._paychanReady = false

    this._watcher = new ChannelWatcher(60 * 1000, this._api)
    this._watcher.on('channelClose', () => {
      debug('channel closing; triggering auto-disconnect')
      // TODO: should we also close our own channel?
      this.disconnect()
    })
  }

  xrpToBase (amount) {
    return new BigNumber(amount)
      .times(Math.pow(10, this._currencyScale))
      .toString()
  }

  baseToXrp (amount) {
    return new BigNumber(amount)
      .div(Math.pow(10, this._currencyScale))
      .toFixed(6, BigNumber.ROUND_UP)
  }

  async _setIncomingChannel (newId) {
    if (!this._incomingChannel) {
      debug('validating incoming paychan')
      const details = await this._api.getPaymentChannel(newId)
      this._validateChannelDetails(details)

      debug('checking that peer\'s scale matches')
      await this._getPeerInfo()

      // second check occurs to prevent race condition where two lookups happen at once
      if (!this._incomingChannel) {
        debug(`setting incoming channel to`, newId)
        debug(`channel details are`, details)
        this._incomingChannel = newId
        this._incomingChannelDetails = details
        this._store.set('incoming_channel', this._incomingChannel)
        await this._watcher.watch(this._incomingChannel)
      }
    }
  }

  async _handleData (from, { requestId, data }) {
    if (!this._paychanReady) throw new Error('paychan initialization has not completed or has failed.')

    const { ilp, protocolMap } = this.protocolDataToIlpAndCustom(data)

    if (protocolMap.info) {
      debug('got info request from peer')

      return [{
        protocolName: 'info',
        contentType: BtpPacket.MIME_APPLICATION_JSON,
        data: Buffer.from(JSON.stringify({
          currencyScale: this._currencyScale
        }))
      }]
    }

    if (protocolMap.ripple_channel_id) {
      debug('got ripple_channel_id request from peer')
      await this._setIncomingChannel(protocolMap.ripple_channel_id)
      await this._reloadIncomingChannelDetails()

      return [{
        protocolName: 'ripple_channel_id',
        contentType: BtpPacket.MIME_TEXT_PLAIN_UTF8,
        data: Buffer.from(this._outgoingChannel || '')
      }]
    } else if (!this._incomingChannel || !this._incomingChannelDetails) {
      await this._reloadIncomingChannelDetails()
    }

    if (!this._dataHandler) {
      throw new Error('no request handler registered')
    }

    if (!ilp) {
      throw new Error('no ilp protocol on request')
    }

    const response = await this._dataHandler(ilp)
    return this.ilpAndCustomToProtocolData({ ilp: response })
  }

  async _sendRippleChannelIdRequest () {
    return this._call(null, {
      type: BtpPacket.TYPE_MESSAGE,
      requestId: await util._requestId(),
      data: { protocolData: [{
        protocolName: 'ripple_channel_id',
        contentType: BtpPacket.MIME_TEXT_PLAIN_UTF8,
        data: Buffer.from(this._outgoingChannel)
      }] }
    })
  }

  async _reloadIncomingChannelDetails () {
    if (!this._incomingChannel) {
      debug('quering peer for incoming channel id')
      let chanId = null
      try {
        const response = await this._sendRippleChannelIdRequest()

        // TODO: should this send raw bytes instead of text in the future
        debug('got ripple_channel_id response:', response)
        chanId = response
          .protocolData
          .filter(p => p.protocolName === 'ripple_channel_id')[0]
          .data
          .toString()
      } catch (err) {
        debug('error requesting incoming channel from peer.', err)
        return
      }

      await this._setIncomingChannel(chanId)
    } else {
      debug('refreshing details for incoming channel', this._incomingChannel)
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
    }

    this._lastClaimedAmount = new BigNumber(this.xrpToBase(this._incomingChannelDetails.balance))
    this._setupAutoClaim()
  }

  async _getPeerInfo () {
    // now uses the info protocol to make sure scales are matching
    let infoResponse
    try {
      debug('quering peer for info')
      infoResponse = await this._call(null, {
        type: BtpPacket.TYPE_MESSAGE,
        requestId: await util._requestId(),
        data: { protocolData: [{
          protocolName: 'info',
          contentType: BtpPacket.MIME_APPLICATION_OCTET_STREAM,
          data: Buffer.from([ util.INFO_REQUEST_ALL ])
        }] }
      })
    } catch (e) {
      if (this._currencyScale !== 6) {
        throw new Error('peer is unable to accomodate our currencyScale;' +
          ' they are on an out of date version of this plugin. error=' +
          e.stack)
      } else {
        debug('peer is on an outdated plugin, but currency scales match')
      }
    }

    if (infoResponse) {
      const protocol = infoResponse.protocolData[0]
      if (protocol.protocolName !== 'info') throw new Error('invalid response to info request')
      const info = JSON.parse(protocol.data.toString())
      debug('info subprotocol response is:', info)
      if (info.currencyScale !== this._currencyScale) {
        throw new Error('Fatal! Currency scale mismatch. this=' + this._currencyScale +
          ' peer=' + (info.currencyScale || 6))
      }
    }
  }

  async _isClaimProfitable () {
    const income = new BigNumber(this._incomingClaim.amount).minus(this._lastClaimedAmount)
    const fee = new BigNumber(this.xrpToBase(await this._api.getFee()))

    return income.isGreaterThan(0) && fee.dividedBy(income).lte(this._maxFeePercent)
  }

  _setupAutoClaim () {
    if (!this._claimIntervalId) {
      this._claimIntervalId = setInterval(async () => {
        if (await this._isClaimProfitable()) {
          debug('starting automatic claim. amount=' + this._incomingClaim.amount)
          this._lastClaimedAmount = new BigNumber(this._incomingClaim.amount)
          await this._claimFunds()
          debug('claimed funds.')
        }
      }, this._claimInterval)
    }
  }

  _validateChannelDetails (details) {
    // Make sure the watcher has enough time to submit the best
    // claim before the channel closes
    const settleDelay = details.settleDelay
    if (settleDelay < util.MIN_SETTLE_DELAY) {
      debug(`incoming payment channel has a too low settle delay of ${settleDelay.toString()}` +
        ` seconds. Minimum settle delay is ${util.MIN_SETTLE_DELAY} seconds.`)
      throw new Error('settle delay of incoming payment channel too low')
    }

    if (details.cancelAfter) {
      debug(`channel has cancelAfter set`)
      throw new Error('cancelAfter must not be set')
    }

    if (details.expiration) {
      debug(`channel has expiration set`)
      throw new Error('expiration must not be set')
    }

    if (details.destination !== this._address) {
      debug('incoming channel destination is not our address: ' +
        details.destination)
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

    await this._store.load('incoming_channel')
    await this._store.load('outgoing_channel')
    await this._store.load('incoming_claim')
    await this._store.load('outgoing_claim')

    this._incomingChannel = this._store.get('incoming_channel')
    this._outgoingChannel = this._store.get('outgoing_channel')
    this._incomingClaim = JSON.parse(this._store.get('incoming_claim') || '{"amount":"0"}')
    this._outgoingClaim = JSON.parse(this._store.get('outgoing_claim') || '{"amount":"0"}')
    debug('loaded incoming claim:', this._incomingClaim)

    if (this._incomingChannel) {
      await this._watcher.watch(this._incomingChannel)
      await this._reloadIncomingChannelDetails()
    }

    if (!this._outgoingChannel) {
      debug('creating new payment channel')

      let ev
      try {
        const txTag = util.randomTag()
        ev = await this._txSubmitter.submit('preparePaymentChannelCreate', {
          amount: this.baseToXrp(this._channelAmount),
          destination: this._peerAddress,
          settleDelay: this._settleDelay,
          publicKey: 'ED' + Buffer.from(this._keyPair.publicKey).toString('hex').toUpperCase(),
          sourceTag: txTag
        })
      } catch (err) {
        debug('Error creating payment channel')
        throw err
      }

      this._outgoingChannel = util.computeChannelId(
        ev.transaction.Account,
        ev.transaction.Destination,
        ev.transaction.Sequence
      )
      this._store.set('outgoing_channel', this._outgoingChannel)

      debug('payment channel successfully created: ', this._outgoingChannel)
    }

    await this._reloadOutgoingChannelDetails()
    this._paychanReady = true
  }

  async _reloadOutgoingChannelDetails () {
    while (true) {
      try {
        this._outgoingChannelDetails = await this._api.getPaymentChannel(this._outgoingChannel)
        break
      } catch (e) {
        if (e.name === 'TimeoutError') {
          await new Promise(resolve => setTimeout(resolve, 2000))
          continue
        } else {
          throw e
        }
      }
    }
  }

  async _claimFunds () {
    if (!this._incomingClaim.signature) {
      return
    }

    await this._txSubmitter.submit('preparePaymentChannelClaim', {
      balance: this.baseToXrp(this._incomingClaim.amount),
      channel: this._incomingChannel,
      signature: this._incomingClaim.signature.toUpperCase(),
      publicKey: this._incomingChannelDetails.publicKey
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
    const dropClaimAmount = util.xrpToDrops(this.baseToXrp(claimAmount))
    const encodedClaim = util.encodeClaim(dropClaimAmount, this._outgoingChannel)
    const signature = nacl.sign.detached(encodedClaim, this._keyPair.secretKey)

    debug(`signed outgoing claim for ${claimAmount.toString()} drops on ` +
      `channel ${this._outgoingChannel}`)

    if (!this._funding && new BigNumber(dropClaimAmount).isGreaterThan(new BigNumber(util.xrpToDrops(this._outgoingChannelDetails.amount)).times(this._fundThreshold))) {
      this._funding = true
      util.fundChannel({
        api: this._api,
        channel: this._outgoingChannel,
        amount: util.xrpToDrops(this._outgoingChannelDetails.amount),
        address: this._address,
        secret: this._secret
      })
        .then(async () => {
          await this._sendRippleChannelIdRequest()
          await this._reloadOutgoingChannelDetails()
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
    if (!this._paychanReady) throw new Error('paychan initialization has not completed or has failed.')

    if (!this._incomingChannelDetails || !this._incomingChannel) {
      await this._reloadIncomingChannelDetails()
    }

    const amount = data.amount
    const protocolData = data.protocolData
    const claim = JSON.parse(protocolData
      .filter(p => p.protocolName === 'claim')[0]
      .data
      .toString())

    const claimAmount = new BigNumber(claim.amount)
    const dropClaimAmount = util.xrpToDrops(this.baseToXrp(claimAmount))
    const encodedClaim = util.encodeClaim(dropClaimAmount, this._incomingChannel)
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
        ${dropClaimAmount.toString()} drops total`)
      throw new Error('got invalid claim signature ' +
        claim.signature + ' for amount ' + dropClaimAmount.toString() +
        ' drops total')
    }

    // validate claim against balance
    const channelAmount = util.xrpToDrops(this._incomingChannelDetails.amount)
    if (new BigNumber(dropClaimAmount).isGreaterThan(channelAmount)) {
      const message = 'got claim for amount higher than channel balance. amount: ' +
        dropClaimAmount.toString() +
        ' incoming channel amount: ' +
        channelAmount

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
