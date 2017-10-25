'use strict'

const BigNumber = require('bignumber.js')
const util = require('../util')
const nacl = require('tweetnacl')
const encode = require('../util/encode')
const debug = require('debug')('ilp-plugin-xrp-paychan:incoming-channel')

module.exports = class IncomingChannel {
  constructor (opts) {
    this._api = opts.api
    this._secret = opts.secret
    this._address = opts.address
    this._bestClaim = opts.bestClaim
    this._claim = null
    // TODO: stop hardcoding this
    this._settlePercent = new BigNumber('0.8')
    this._maximum = new BigNumber('0')

    // TODO: how to listen for the channel's pending expiry
  }

  getMax () {
    return this._maximum
  }

  async create ({ channelId }) {
    // fetches details from the network to initialize
    this._channelId = channelId
    await this._store.put('channel_i', channelId)

    const paychan = await this._api.getPaymentChannel(channelId)
    if (paychan.destination !== this._address) {
      throw new Error('channel destination is ' + paychan.destination +
        ' but our address is ' + this._address)
    }

    this._publicKey = Buffer.from(paychan.publicKey, 'hex').slice(1)
    this._maximum = new BigNumber(paychan.amount).mul(1000000)
  }

  async receive ({ balance, claim }) {
    if (!this._channelId) {
      debug('trying to receive claim on uninitialized channel')
      throw new Error('incoming channel has not been created')
    }

    const ourClaim = encode.getClaimMessage(this._channelId, balance)
    debug('verifying signature "', claim, '" on', ourClaim.toString('hex'))
    const verified = nacl.sign.detached.verify(
      Buffer.from(ourClaim, 'hex'),
      Buffer.from(claim, 'hex'),
      this._publicKey)

    if (!verified) {
      // TODO: print the claim here
      debug('signature was invalid')
      throw new Error('signature (', claim, ') is invalid for claim:',
        ourClaim)
    }

    debug('got valid claim for balance:', balance)
    this.tracker.setIfMax({
      value: balance,
      data: claim
    })

    debug('checking threshold')
    const threshold = new BigNumber(this.max).mul(this._settlePercent)

    // TODO: check if this should be claimed
    if (new BigNumber(balance).gt(threshold)) {
      this._claimFunds().catch((e) => { console.error(e) })
    }
  }

  async _claimFunds () {
    const bestClaim = await this._bestClaim.getMax()
    const claim = bestClaim.data
    const balance = bestClaim.value

    debug('preparing claim tx')
    const tx = await this._api.preparePaymentChannelClaim(this._address, {
      balance: util.dropsToXrp(balance),
      channel: this._channelId,
      signature: claim,
      publicKey: 'ED' + this._publicKey.toString('hex').toUpperCase()
    })

    debug('signing claim funds tx for balance:', balance.toString())
    const signedTx = this._api.sign(tx.txJSON, this._secret)
    const result = await this._api.submit(signedTx.signedTransaction)
    debug('got claim submit result:', result)

    const api = this._api
    function claimCheck (ev) {
      if (ev.transaction.TransactionType !== 'PaymentChannelClaim') return
      debug('got claim notification:', ev)
      if (ev.transaction.Signature !== claim) return

      debug('successfully processed claim for:', balance)
      api.connection.removeListener('transaction', claimCheck)
    }

    // don't wait on this to complete, because the connector will time the
    // fulfill call out.
    this._api.connection.on('transaction', claimCheck)
  }

  async reloadChannelDetails () {
    debug('reloading channel details')
    const paychan = await this._api.getPaymentChannel(this._channelId)
    debug('got payment channel details:', paychan)

    const newMax = new BigNumber(paychan.amount).mul(1000000)
    debug('setting new channel maximum to', newMax.toString())
    this._maximum = newMax
  }
}
