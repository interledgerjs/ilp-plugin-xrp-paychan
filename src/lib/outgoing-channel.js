'use strict'

// TODO: faster library for crypto?
const nacl = require('tweetnacl')
const BigNumber = require('bignumber.js')
const co = require('co')
const util = require('../util')
const Balance = require('./balance')

const getClaimMessage = (channelId, amount) => {
  const hashPrefix = Buffer.from('CLM\0', 'ascii')
  const idBuffer = Buffer.from(channelId, 'hex')
  const amountBuffer = util.toBuffer(new BigNumber(amount).mul('1000000'), 8)

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
      name: 'balance_o',
      maximum: this._amount,
      store: this._store
    })
  }

  * create () {
    const existingChannel = yield this._store.get('channel_o')
    if (existingChannel) {
      this._channelId = existingChannel
      return
    }

    const txTag = util.randomTag()
    const tx = yield this._api.preparePaymentChannelCreate(this._address, {
      amount: this._amount,
      destination: this._destination,
      settleDelay: 90000,
      publicKey: 'ED' + Buffer.from(this._keyPair.publicKey).toString('hex').toUpperCase(),
      sourceTag: txTag
      // TODO: specify a cancelAfter?
    })

    console.log('PUBLIC KEY:', Buffer.from(this._keyPair.publicKey).toString('hex').toUpperCase())
    const signedTx = this._api.sign(tx.txJSON, this._secret)
    const result = yield this._api.submit(signedTx.signedTransaction)

    /*console.log('submitted transaction:', result)
    console.log('source tag:', txTag)*/

    return new Promise((resolve) => {
      // TODO: remove this listener
      this._api.connection.on('transaction', (ev) => {
        /*console.log('got event:', ev)
        console.log('tags are:', ev.transaction.SourceTag, txTag)*/
        if (ev.transaction.SourceTag !== txTag) return
        //console.log('got the right source tag')
        // if the source tags somehow match up
        if (ev.transaction.Account !== this._address) return
        //console.log('trying to create channel ID now')

        const channelId = util.channelId(
          this._address,
          this._destination,
          ev.transaction.Sequence)

        //console.log('got channel ID:', channelId)
        this._channelId = channelId
        this._hash = ev.transaction.hash

        this._store.put('channel_o', channelId)
          .then(() => resolve())
          .catch((e) => {
            console.error(e)
          })
      })
    })
  }

  getChannelId () {
    return this._channelId
  }

  getHash () {
    return this._hash
  }

  * send (transfer) {
    if (!this._channelId) {
      throw new Error('channel has not been created')
    }

    // TODO: maybe this has to re-fund the channel?

    // this will complain if the amount exceeds the maximum
    yield this._balance.add(transfer.amount)
    const claim = yield this._balance.get()

    console.log('making claim: ' + claim)

    const message = getClaimMessage(this._channelId, claim)
    console.log('made claim:', message)
    const signature = nacl.sign.detached(message, this._keyPair.secretKey)

    return Buffer.from(signature).toString('hex')
  }
}
