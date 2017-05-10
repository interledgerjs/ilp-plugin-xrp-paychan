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

    // TODO: get this channel by the transaction hash?
    // TODO: how to listen for the channel's pending expiry
  }

  * getBalance () {
    if (!this._channelId) throw new Error('must be connected before getBalance')
    return yield this._balance.get()
  }

  * create ({ hash }) {
    // fetches details from the network to initialize
    this._hash = hash
    yield this._store.put('hash_i', hash)

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

    this._maximum = new BigNumber(this._tx.Amount)
    this._balance = new Balance({
      //     123456789
      name: 'balance_i',
      maximum: this._maximum.toString(),
      store: this._store
    })
  }

  * receive (transfer, claim) {
    if (!this._channelId) {
      throw new Error('incoming channel has not been created')
    }

    const oldBalance = new BigNumber(yield this._balance.get())
    const newBalance = oldBalance
      .add(transfer.amount)

    debug('processing claim for transfer with id:', transfer.id)
    const ourClaim = encode.getClaimMessage(this._channelId, newBalance.toString())
    const verified = nacl.sign.detached.verify(
      Buffer.from(ourClaim, 'hex'),
      Buffer.from(claim, 'hex'),
      this._publicKey)

    if (!verified) {
      // TODO: print the claim here
      throw new Error('signature (', claim, ') is invalid for claim:',
        ourClaim)
    }

    debug('got valid claim for transfer id:', transfer.id,
      'amount:', transfer.amount)

    // if the other side is sending claims we can't cash, then this will
    // figure it out
    yield this._balance.add(transfer.amount)
    this._claim = claim


    const threshold = this._maximum.mul(this._settlePercent)
    debug('new balance:', newBalance.toString(),
      'maximum:', this._maximum.toString(),
      'threshold:', threshold.toString())

    // TODO: check if this should be claimed
    if (newBalance.gt(this._maximum.mul(this._settlePercent))) {
      // this should go asynchronously?
      debug('new balance', newBalance.toString(),
        'exceeds threshold', threshold.toString(),
        '. submitting claim tx.')
      yield this._claimFunds()
      //co(this._claimFunds.bind(this))
    }
  }

  * _claimFunds () {
    const txTag = util.randomTag()
    const balance = yield this._balance.get()
    const tx = yield this._api.preparePaymentChannelClaim(this._address, {
      balance: util.dropsToXrp(balance),
      channel: this._channelId,
      signature: this._claim.toUpperCase(),
      publicKey: 'ED' + this._publicKey.toString('hex').toUpperCase(),
    })

    debug('signing claim funds tx for balance:', balance.toString())
    const signedTx = this._api.sign(tx.txJSON, this._secret)
    const result = yield this._api.submit(signedTx.signedTransaction)
    const claim = this._claim.toString('hex').toUpperCase()

    return new Promise((resolve) => {
      const api = this._api

      function claimCheck (ev) {
        if (ev.transaction.TransactionType !== 'PaymentChannelClaim') return
        if (ev.transaction.Signature !== claim) return

        debug('successfully processed claim for:', balance.toString())
        api.connection.removeListener('transaction', claimCheck)
        resolve()
      }

      this._api.connection.on('transaction', claimCheck)
    })
  }

  * receiveFund (hash) {
    const fundTx = yield this._api.connection.request({
      command: 'tx',
      transaction: hash
    })

    // the fund notification is out of date
    if (fundTx.Sequence < this._lastSequence) {
      debug('got out of date fund tx with hash:', hash)
      return
    }

    this._lastSequence = fundTx.Sequence
    const channel = this._channelId.toString('hex').toUpperCase()
    fundTx.meta.AffectedNodes.forEach((node) => {
      if (!node.ModifiedNode) return

      console.log('processing fund update node:', node)
      console.log('index', node.ModifiedNode.LedgerIndex, 'channel', channel)
      if (node.ModifiedNode.LedgerIndex !== channel) {
        return
      }

      const newMax = new BigNumber(node.ModifiedNode.FinalFields.Amount)

      console.log('setting new channel maximum to', newMax.toString())
      this._balance.setMax(newMax)
    })
  }
}
