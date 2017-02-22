'use strict'

// TODO: faster library for crypto?
const nacl = require('tweetnacl')
const bignum = require('bignum')
const co = require('co')
const util = require('../util')
const Balance = require('./balance')

const getClaimMessage = (channelId, amount) => {
  const hashPrefix = Buffer.from('CLM\0', 'ascii')
  const idBuffer = Buffer.from(channelId, 'hex')
  const amountBuffer = bignum(amount)
    .mul('1000000')
    .toBuffer({ endian: 'big', size: 4 })

  return Buffer.concat([
    hashPrefix, idBuffer, amountBuffer
  ])
}

module.exports = class OutgoingChannel {
  constructor (opts) {
    this._api = opts.api
    this._address = opts.address
    this._secret = opts.secret
    this._amount = opts.amount
    this._destination = opts.destination
    this._store = opts.store
    this._keyPair = nacl.sign.keyPair.fromSeed(util.sha256(opts.channelSecret))
    this._balance = new Balance({
      //     123456789
      name: 'balance_o'
      maximum: this._amount,
      store: this._store,
    })
  }

  * create () {

    // TODO: look up channel in table

    console.log(this._address, this._destination)
    const tx = yield this._api.preparePaymentChannelCreate(this._address, {
      amount: this._amount,
      destination: this._destination,
      settleDelay: 90000,
      publicKey: Buffer.from(this._keyPair.publicKey).toString('hex').toUpperCase()
      // TODO: specify a cancelAfter?
    })
    console.log(JSON.stringify(JSON.parse(tx.txJSON)), null, 2)

    const signedTx = this._api.sign(tx.txJSON, this._secret)
    const result = yield this._api.submit(signedTx.signedTransaction)
    console.log('submitted transaction:', result)

    // TODO: wait for the validation on the network?
    // TODO: store the hash in the store
    // TODO: broadcast the hash to the peer and wait on that for connect event
  }

  * send (transfer) {
    if (!this._channelId) {
      throw new Error('channel has not been created')
    }

    // TODO: maybe this has to re-fund the channel?

    // this will complain if the amount exceeds the maximum
    yield this._balance.add(transfer.amount)

    const message = getClaimMessage(this._channelId, transfer.amount)
    const signature = nacl.sign(message, this._keyPair.secretKey)
    return Buffer.from(signature).toString('hex')
  }
}
