'use strict'

// TODO: faster library for crypto?
const nacl = require('tweetnacl')
const BigNumber = require('bignumber.js')
const util = require('../util')
const EventEmitter2 = require('eventemitter2')
const encode = require('../util/encode')
const debug = require('debug')('ilp-plugin-xrp-paychan:outgoing-channel')
const uuid = require('uuid')

module.exports = class OutgoingChannel extends EventEmitter2 {
  constructor (opts) {
    super()

    this._increment = 1
    this._api = opts.api
    this._address = opts.address
    this._secret = opts.secret
    this._amount = opts.amount
    this._fundPercent = new BigNumber('0.8')
    this._destination = opts.destination
    this._store = opts.store
    this._keyPair = nacl.sign.keyPair.fromSeed(util.sha256(opts.channelSecret))
    this._channelCreationStage = opts.channelCreationStage
  }

  async _createChannel () {
    const txTag = util.randomTag()
    const tx = await this._api.preparePaymentChannelCreate(this._address, {
      amount: util.dropsToXrp(this._amount),
      destination: this._destination,
      settleDelay: 90000,
      publicKey: 'ED' + Buffer.from(this._keyPair.publicKey).toString('hex').toUpperCase(),
      sourceTag: txTag
    })

    const signedTx = this._api.sign(tx.txJSON, this._secret)
    const result = await this._api.submit(signedTx.signedTransaction)

    return new Promise((resolve) => {
      function handleTransaction (ev) {
        if (ev.transaction.SourceTag !== txTag) return
        if (ev.transaction.Account !== this._address) return

        const channelId = util.channelId(
          this._address,
          this._destination,
          ev.transaction.Sequence)

        debug('created outgoing channel with ID:', channelId)
        this._channelId = channelId

        this._channelCreationStage.setIfMax({ value: '2', data: channelId })
          .then(() => resolve())
          .catch((e) => {
            debug('store error:', e)
          })

        setImmediate(() => this._api.connection
          .removeListener('transaction', handleTransaction))
      }

      this._api.connection.on('transaction', handleTransaction.bind(this))
    })
  }
  
  async create () {
    const randomTag = uuid()
    const bumped = await this._channelCreationStage.setIfMax({ value: '1', data: randomTag })
    const myJob = (bumped.data !== randomTag)

    if (myJob) {
      await this._createChannel()
    } else {
      let current = bumped
      while (current.value !== '2') {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        current = await this._channelCreationStage.getMax()
      }

      this._channelId = current.data
    }
  }

  getChannelId () {
    debug('fetching channel ID', this._channelId)
    return this._channelId
  }

  async createClaim (outgoingBalance) {
    if (!this._channelId) {
      throw new Error('channel has not been created')
    }

    const message = encode.getClaimMessage(this._channelId, outgoingBalance)
    const signature = nacl.sign.detached(message, this._keyPair.secretKey)
    return Buffer.from(signature).toString('hex')
  }

  async _fundChannel () {
    const tx = await this._api.preparePaymentChannelFund(this._address, {
      channel: this._channelId,
      amount: util.dropsToXrp(this._amount)
    })

    debug('fund transaction:', tx.txJSON)
    const signedTx = this._api.sign(tx.txJSON, this._secret)
    debug('submitting fund tx for an additional:', this._amount)
    const result = await this._api.submit(signedTx.signedTransaction)
    debug('fund submit result:', result)

    const that = this
    function fundCheck (ev) {
      debug('fund listener processing event:', ev)
      if (ev.transaction.TransactionType !== 'PaymentChannelFund') return
      if (ev.transaction.Channel !== that._channelId) return

      debug('fund tx completed')
      that._api.connection.removeListener('transaction', fundCheck)
      return that.emitAsync('fund', ev.transaction)
    }

    this._api.connection.on('transaction', fundCheck)
  }
}
