'use strict'

const Balance = require('./balance')
const BigNumber = require('bignumber.js')
const bignum = require('bignum')
const util = require('../util')
const nacl = require('tweetnacl')
const encode = require('../util/encode')
const co = require('co')
const debug = require('debug')('ilp-plugin-xrp-paychan:incoming-channel')

module.exports = class IncomingChannel {
  constructor (opts) {
    this._api = opts.api
    this._secret = opts.secret
    this._address = opts.address
    // TODO: uintarray, buffer, or string?
    this._balance = null 
    this._store = opts.store
    this._claim = null
    // TODO: stop hardcoding this
    this._settlePercent = new BigNumber('0.8')

    // TODO: how to listen for the channel's pending expiry
  }

  * getBalance () {
    if (!this._channelId) throw new Error('must be connected before getBalance')
    return yield this._balance.get()
  }

  * create ({ channelId }) {
    // fetches details from the network to initialize
    this._channelId = channelId
    yield this._store.put('channel_i', channelId)

    const paychan = yield this._api.getPaymentChannel(channelId)
    if (paychan.destination !== this._address) {
      throw new Error('channel destination is ' + paychan.destination
        + ' but our address is ' + this._address)
    }

    this._publicKey = Buffer.from(paychan.publicKey, 'hex').slice(1)
    const maximum = new BigNumber(paychan.amount).mul(1000000)
    this._balance = new Balance({
      //     123456789
      name: 'balance_i',
      maximum: maximum.toString(),
      store: this._store
    })
  }

  * receive (transfer, claim) {
    if (!this._channelId) {
      debug('trying to receive claim on uninitialized channel')
      throw new Error('incoming channel has not been created')
    }

    const oldBalance = new BigNumber(yield this._balance.get())
    debug('adding', transfer.amount, 'to', oldBalance.toString())
    const newBalance = oldBalance
      .add(transfer.amount)

    debug('processing claim for transfer with id:', transfer.id)
    const ourClaim = encode.getClaimMessage(this._channelId, newBalance.toString())
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

    debug('got valid claim for transfer id:', transfer.id,
      'amount:', transfer.amount)

    // if the other side is sending claims we can't cash, then this will
    // figure it out
    debug('adding transfer amount to balance')
    yield this._balance.add(transfer.amount)
    this._claim = claim


    debug('checking threshold')
    const threshold = this._balance.getMax().mul(this._settlePercent)
    debug('new balance:', newBalance.toString(),
      'maximum:', this._balance.toString(),
      'threshold:', threshold.toString())

    // TODO: check if this should be claimed
    if (newBalance.gt(threshold)) {
      // this should go asynchronously?
      debug('new balance', newBalance.toString(),
        'exceeds threshold', threshold.toString(),
        '. submitting claim tx.')
      yield co.wrap(this._claimFunds).call(this).catch((e) => {
        console.error(e)
        throw e
      })
      //co(this._claimFunds.bind(this))
    }
  }

  * _claimFunds () {
    const txTag = util.randomTag()
    const balance = yield this._balance.get()
    debug('preparing claim tx')
    const tx = yield this._api.preparePaymentChannelClaim(this._address, {
      balance: util.dropsToXrp(balance),
      channel: this._channelId,
      signature: this._claim.toUpperCase(),
      publicKey: 'ED' + this._publicKey.toString('hex').toUpperCase(),
    })

    debug('signing claim funds tx for balance:', balance.toString())
    const signedTx = this._api.sign(tx.txJSON, this._secret)
    const result = yield this._api.submit(signedTx.signedTransaction)

    debug('got claim submit result:', result)
    const claim = this._claim.toString('hex').toUpperCase()

    const api = this._api
    function claimCheck (ev) {
      if (ev.transaction.TransactionType !== 'PaymentChannelClaim') return
      debug('got claim notification:', ev)
      if (ev.transaction.Signature !== claim) return

      debug('successfully processed claim for:', balance.toString())
      api.connection.removeListener('transaction', claimCheck)
    }

    // don't wait on this to complete, because the connector will time the
    // fulfill call out.
    this._api.connection.on('transaction', claimCheck)
  }

  * reloadChannelDetails () {
    debug('reloading channel details')
    const paychan = yield this._api.getPaymentChannel(this._channelId)
    debug('got payment channel details:', paychan)

    const newMax = new BigNumber(paychan.amount).mul(1000000)
    debug('setting new channel maximum to', newMax.toString())
    this._balance.setMax(newMax)
  }
}
