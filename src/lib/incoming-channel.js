'use strict'

const nacl = require('tweetnacl')
const co = require('co')

module.exports = class IncomingChannel {
  constructor (opts) {
    this._api = opts.api
    this._hash = opts.hash
    // TODO: needs a secret once it starts claiming and stuff
    this._address = opts.address
    // TODO: uintarray, buffer, or string?
    this._publicKey = opts.publicKey
    this._balance = null 
    this._store = opts.store
    this._claim = null

    // TODO: get this channel by the transaction hash?
    // TODO: how to listen for the channel's pending expiry
  }

  * create () {
    // fetches details from the network to initialize
    this._tx = yield this._api.connection.request({
      command: 'tx',
      transaction: this._hash
    })

    if (this._tx.Destination !== this._address) {
      throw new Error('channel destination is ' + this._tx.Destination
        + ' but our address is ' + this._address)
    }

    this._channelId = util.channelId(
      this._tx.Account,
      this._tx.Destination,
      this._tx.Sequence)

    this._balance = new Balance({
      //     123456789
      name: 'balance_i'
      maximum: bignum(this._tx.Amount).div('1000000').toString(),
      store: this._store,
    })
  }

  * receive (transfer, claim) {
    if (!this._channelId) {
      throw new Error('channel has not been created')
    }

    // TODO: when to submit claims?

    const message = Buffer.from(nacl.sign.open(claim, this._publicKey))
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

    const balance = yield this._balance.get()
    const newAmount = bignum(balance)
      .add(transfer.amount)
      .mul('1000000')

    const signedAmount = bignum.fromBuffer(amount, {
      endian: 'big',
      size: 4
    })

    if (!newAmount.eq(signedAmount)) {
      throw new Error('claim amount doesn\'t match transfer amount. Transfer: '
        + transfer.amount + ' XRP. Balance: '
        + balance + ' XRP. Claimed amount: '
        + signedAmount.toString() + ' Drops.')
    }

    // if the other side is sending claims we can't cash, then this will
    // figure it out
    yield this._balance.add(transfer.amount)
  }
}
