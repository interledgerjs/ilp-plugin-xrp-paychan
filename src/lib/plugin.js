'use strict'

const base64url = require('base64url')
const RippleAPI = require('ripple-lib').RippleAPI
const co = require('co')
const util = require('../util')
const Errors = require('../util/errors')

const wait = (timeout) => (new Promise((resolve, reject) => {
  setTimeout(() => {
    if (timeout) reject(new Error('timed out'))
  }, timeout)
}))

module.exports = class PluginPaychan {
  constructor (opts) {
    this._server = opts.server
    this._address = opts.address
    this._secret = opts.secret
    this._channelSecret = opts.channelSecret
    this._peerAddress = opts.peerAddress
    this._peerPublicKey = opts.peerPublicKey
    this._rpcUri = opts.rpcUri

    this._rpc = new HttpRPC(this._rpcUri, this)
    this._api = new RippleAPI({ server: this._server })

    // bind the RPC methods
    this._rpc.addMethod('send_transfer', this._handleSendTransfer)
    this._rpc.addMethod('send_message', this._handleSendMessage)
    this._rpc.addMethod('fulfill_condition', this._handleFulfillCondition)

    // public methods bound to generators
    this.sendTransfer = co.wrap(this._sendTransfer).bind(this)
    this.sendMessage = co.wrap(this._sendMessage).bind(this)
  }

  connect ({ timeout }) {
    const that = this
    return Promise.race([
      (co.wrap(this._connect).bind(this))(),
      wait(timeout).catch((e) => {
        throw new Error('timed out while connecting to: ' + this._server) 
      })
    ])
  }

  * _connect () {
    yield this.api.connect()
    yield this.api.connection.request({
      command: 'subscribe',
      accounts: [ this._address ]
    })
  }

  getAccount () {
    return 'g.crypto.ripple.' + this._address
  }

  getInfo () {
    return {
      prefix: 'g.crypto.ripple.',
      scale: 6,
      precision: 12,
      currencySymbol: 'XRP',
      currencyCode: 'XRP'
    }
  }

  * _sendTransfer (rawTransfer) {
    const transfer = Object.assign({ ledger: this._prefix }, rawTransfer)
    this._validator.validateOutgoingTransfer(transfer)

    yield this._rpc.call('send_transfer', this._prefix, [
      util.omit(transfer, 'noteToSelf'),
    ])

    yield this._emitAsync('outgoing_prepare', transfer))
  }

  * _handleSendTransfer (transfer, claim) {
    this._validator.validateIncomingTransfer(transfer)

    const optimistic = !transfer.executionCondition
    yield this._emitAsync('incoming_prepare', transfer)

    return true
  }

  * _fulfillCondition (transferId, fulfillment) {
    this._validator.validateFulfillment(fulfillment)

    yield this._transfers.assertIncoming(transferId)
    yield this._transfers.assertAllowedChange(transferId, 'executed')
    const transfer = yield this._transfers.get(transferId)

    this.validateFulfillment(fulfillment, transfer)

    if (yield this._transfers.fulfill(transferId, fulfillment)) {
      yield this.emitAsync('incoming_fulfill', transfer, fulfillment)

      // TODO: should the claim get rolled back if fulfill condition returns an error 
      const claim = yield this._rpc.call('fulfill_condition', this._prefix, [
        transferId, fulfillment, claim
      ])

      yield this._incomingChannel.receive(transfer, claim)
    }
  }

  * _handleFulfillCondition (transferId, fulfillment, claim) {
    this._validator.validateFulfillment(fulfillment)

    yield this._transfers.assertOutgoing(transferId)
    yield this._transfers.assertAllowedChange(transferId, 'executed')
    const transfer = yield this._transfers.get(transferId)

    if (yield this._transfers.fulfill(transferId, fulfillment)) {
      yield this.emitAsync('outgoing_fulfill', transfer, fulfillment)
      // gets the claim from the outgoing channel
      // TODO: different method name?
      return yield this._outgoingChannel.send(transfer)
    }
  }

  validateFulfillment (fulfillment, transfer) {
    // TODO: is this crypto condition format? should use five-bells-condition?
    if (base64url(util.sha256(fulfillment)) !== transfer.executionCondition) {
      throw new Errors.NotAcceptedError('fulfillment (' + fulfillment
        + ') does not match condition (' + transfer.executionCondition + ')')
    }
  }

  * _sendMessage (message) {
    this._validator.validateOutgoingMessage(message)
    yield this._rpc.call('send_message', this._prefix, [ message ])
    yield this._emitAsync('outgoing_message', message)
  }

  * _handleSendMessage (message) {
    this._validator.validateIncomingMessage(message)
    // TODO: is yielding to event emitters a good idea in RPC calls?
    yield this._emitAsync('incoming_message', message)

    return true
  }
}
