'use strict'

const Balance = require('./balance')
const BigNumber = require('bignumber.js')
const bignum = require('bignum')
const util = require('../util')
const nacl = require('tweetnacl')
const co = require('co')

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

    // TODO: get this channel by the transaction hash?
    // TODO: how to listen for the channel's pending expiry
  }

  * create ({ hash }) {
    // fetches details from the network to initialize
    this._hash = hash
    this._tx = yield this._api.connection.request({
      command: 'tx',
      transaction: this._hash
    })

    if (this._tx.Destination !== this._address) {
      throw new Error('channel destination is ' + this._tx.Destination
        + ' but our address is ' + this._address)
    }

    this._publicKey = Buffer.from(this._tx.PublicKey, 'hex').slice(1)
    this._channelId = util.channelId(
      this._tx.Account,
      this._tx.Destination,
      this._tx.Sequence)

    this._maximum = (new BigNumber(this._tx.Amount)).div('1000000')
    this._balance = new Balance({
      //     123456789
      name: 'balance_i',
      maximum: this._maximum.toString(),
      store: this._store
    })
  }

  * receive (transfer, claim) {
    if (!this._channelId) {
      throw new Error('channel has not been created')
    }

    // TODO: claim the funds
/*
    const message = Buffer.from(nacl.sign.open(
      Buffer.from(claim, 'hex'),
      this._publicKey))
    console.log('signed message:', message)
    const hashPrefix = message.slice(0, 4) // 32-bit  'CLM\0'
    const channelId = message.slice(4, 36) // 256-bit channel ID
    const amount = message.slice(36, 44)   // 64-bit  amount

    if (hashPrefix.toString('ascii') !== 'CLM\0') {
      throw new Error('signed message\'s hashPrefix should be CLM\\0. Got: ' +
        hashPrefix.toString('ascii'))
    }

    if (channelId.toString('hex').toUpperCase() !== this._channelId) {
      throw new Error('channel ID should be ' + this._channelId + '. Got: ' +
        channelId.toString('hex').toUpperCase())
    }

*/
    const oldBalance = new BigNumber(yield this._balance.get())
    const newBalance = oldBalance
      .add(transfer.amount)
      .mul('1000000')
/*
    console.log('AMOUNT:', amount)
    const signedAmount = new BigNumber(bignum.fromBuffer(amount, {
      endian: 'big',
      size: 8
    }).toString())

    if (!newBalance.eq(signedAmount)) {
      throw new Error('claim amount doesn\'t match transfer amount. Transfer: '
        + transfer.amount + ' XRP. Balance: '
        + oldBalance.toString() + ' XRP. Claimed amount: '
        + signedAmount.toString() + ' Drops.')
    }

    console.log('got claim for total ' +
      signedAmount.toString() +
      ' drops on transfer amount ' + transfer.amount)
*/

    // if the other side is sending claims we can't cash, then this will
    // figure it out
    yield this._balance.add(transfer.amount)
    this._claim = claim

    console.log('new balance:',
      newBalance.toString(),
      '\nmaximum:',
      this._maximum.toString(),
      '\nthreshold:',
      this._maximum.mul(this._settlePercent).toString())

    // TODO: check if this should be claimed
    if (newBalance.gt(this._maximum.mul(this._settlePercent))) {
      // this should go asynchronously?
      console.log('the new balance is greater than the threshold')
      yield this._claimFunds()
      //co(this._claimFunds.bind(this))
    }
  }

  * _claimFunds () {
    console.log('getting the balance')

    console.log('preparing to claim the funds')
    const txTag = util.randomTag()
    const tx = yield this._api.preparePaymentChannelClaim(this._address, {
      balance: yield this._balance.get(),
      channel: this._channelId,
      signature: this._claim.toString('hex').toUpperCase(),
      publicKey: 'ED' + this._publicKey.toString('hex').toUpperCase(),
      // TODO: should this maybe get kept open?
      close: true
    })

    console.log('signing claim funds tx')
    const signedTx = this._api.sign(tx.txJSON, this._secret)
    console.log('submitting')
    console.log('signedTx:', signedTx)
    const result = yield this._api.submit(signedTx.signedTransaction)
    console.log('submitted')

    return new Promise((resolve) => {
      this._api.connection.on('transaction', (ev) => {
        if (ev.transaction.SourceTag !== txTag) return
        if (ev.transaction.Channel !== this._channelId) return

        console.log('yay I claimed the funds. what now?')
        resolve()
      })
    })
  }
}
