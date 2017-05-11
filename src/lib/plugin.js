'use strict'

const Validator = require('../util/validator')
const EventEmitter2 = require('eventemitter2')
const base64url = require('base64url')
const HttpRPC = require('./rpc')
const RippleAPI = require('ripple-lib').RippleAPI
const co = require('co')
const util = require('../util')
const Errors = require('../util/errors')
const Balance = require('./balance')
const OutgoingChannel = require('./outgoing-channel')
const IncomingChannel = require('./incoming-channel')
const TransferLog = require('./transferlog')
const debug = require('debug')('ilp-plugin-xrp-paychan')
const BigNumber = require('bignumber.js')

module.exports = class PluginXrpPaychan extends EventEmitter2 {
  constructor (opts) {
    super()

    this._server = opts.server
    this._address = opts.address
    this._secret = opts.secret
    this._channelSecret = opts.channelSecret
    this._peerAddress = opts.peerAddress
    this._rpcUri = opts.rpcUri
    this._store = opts._store
    this._maxInFlight = opts.maxInFlight
    this._channelAmount = opts.channelAmount
    this._prefix = 'g.crypto.ripple.paychan.' +
      ((this._address < this._peerAddress)
        ? this._address + '~' + this._peerAddress
        : this._peerAddress + '~' + this._address) + '.'

    this._validator = new Validator({
      account: this._prefix + this._address,
      peer: this._prefix + this._peerAddress,
      prefix: this._prefix
    })

    this._rpc = new HttpRPC(this._rpcUri, this)
    this._api = new RippleAPI({ server: this._server })
    this._inFlight = new Balance({
      name: 'balance_f',
      maximum: this._maxInFlight,
      store: this._store
    })

    this._transfers = new TransferLog({
      store: this._store
    })

    this._connected = false
    this._incomingChannel = new IncomingChannel({
      api: this._api,
      address: this._address,
      secret: this._secret,
      store: this._store
    })
    this._outgoingChannel = new OutgoingChannel({
      api: this._api,
      address: this._address,
      secret: this._secret,
      channelSecret: this._channelSecret,
      destination: this._peerAddress,
      amount: this._channelAmount,
      store: this._store
    })

    // channel-maximum updating flow
    this._outgoingChannel.on('fund', (tx) => {
      this._rpc.call('_fund', this._prefix, [ tx.hash ])
    })
    // bind the RPC methods
    this._rpc.addMethod('send_transfer', this._handleSendTransfer)
    this._rpc.addMethod('send_message', this._handleSendMessage)
    this._rpc.addMethod('fulfill_condition', this._handleFulfillCondition)
    this._rpc.addMethod('reject_incoming_transfer', this._handleRejectIncomingTransfer)
    this._rpc.addMethod('_expire', this._expire)
    this._rpc.addMethod('_get_hash', this._getHash)
    this._rpc.addMethod('_fund', this._fund)

    // public methods bound to generators
    this.connect = co.wrap(this._connect).bind(this)
    this.disconnect = co.wrap(this._disconnect).bind(this)
    this.getBalance = co.wrap(this._getBalance).bind(this)
    this.sendTransfer = co.wrap(this._sendTransfer).bind(this)
    this.sendMessage = co.wrap(this._sendMessage).bind(this)
    this.fulfillCondition = co.wrap(this._fulfillCondition).bind(this)
    this.rejectIncomingTransfer = co.wrap(this._rejectIncomingTransfer).bind(this)
    this.getFulfillment = co.wrap(this._getFulfillment).bind(this)
    this.receive = co.wrap(this._rpc._receive).bind(this._rpc)
    this.isAuthorized = () => true
  }

  * _getBalance () {
    return (new BigNumber(yield this._outgoingChannel.getBalance()))
      .neg()
      .add(yield this._incomingChannel.getBalance())
      .toString()
  }

  * _connect () {
    // because connecting this plugin can take a long time, the options timeout
    // is disregarded.
    yield this._api.connect()
    yield this._api.connection.request({
      command: 'subscribe',
      accounts: [ this._address ]
    })
    yield this._outgoingChannel.create()

    // we need the RPC to start up before this promise will work
    function * connectIncomingChannel () {
      let hash = yield this._store.get('hash_i')

      if (hash) debug('got incoming channel tx hash from store:', hash)
      while (!hash) {
        try {
          hash = yield this._rpc.call('_get_hash', this._prefix, [])
          debug('got peer payment channel fund tx with hash:', hash)
        } catch (e) {
          debug('get hash failed:', e.message)
        }
        yield util.wait(5000).catch(() => {})
      }

      yield this._incomingChannel.create({ hash })
    }

    this._connectPromise = co.wrap(connectIncomingChannel).call(this)
    this._connected = true
    this.emitAsync('connect')
  }

  * _disconnect () {
    yield this._api.disconnect()
    this._connected = false
  }

  isConnected () {
    return this._connected
  }

  getAccount () {
    return this._prefix + this._address
  }

  getInfo () {
    return {
      prefix: this._prefix,
      scale: 6,
      precision: 12,
      currencySymbol: 'XRP',
      currencyCode: 'XRP'
    }
  }

  * _fund (hash) {
    debug('notified of fund tx with hash:', hash)
    return true
  }

  * _getHash () {
    return this._outgoingChannel.getHash()
  }

  * _sendTransfer (rawTransfer) {
    const transfer = Object.assign({
      from: this.getAccount(),
      ledger: this._prefix
    }, rawTransfer)

    if (transfer.account) {
      transfer.to = transfer.account
    }

    this._validator.validateOutgoingTransfer(transfer)
    yield this._transfers.storeOutgoing(transfer)
    debug('sending transfer:', transfer)

    yield this._rpc.call('send_transfer', this._prefix, [
      Object.assign({}, transfer, { noteToSelf: undefined }),
    ])

    this.emitAsync('outgoing_prepare', transfer)
    yield this._setupExpire(transfer.id, transfer.expiresAt)
  }

  * _handleSendTransfer (transfer) {
    this._validator.validateIncomingTransfer(transfer)
    yield this._transfers.storeIncoming(transfer)
    debug('notified of incoming transfer:', transfer)

    yield this._inFlight.add(transfer.amount)
    transfer.account = transfer.from
    this.emitAsync('incoming_prepare', transfer)
    yield this._setupExpire(transfer.id, transfer.expiresAt)

    return true
  }

  * _fulfillCondition (transferId, fulfillment) {
    this._validator.validateFulfillment(fulfillment)

    yield this._transfers.assertIncoming(transferId)
    yield this._transfers.assertAllowedChange(transferId, 'executed')
    const transfer = yield this._transfers.get(transferId)
    debug('fulfilled incoming transfer:', transfer)

    this._validateFulfillment(fulfillment, transfer)

    if (yield this._transfers.fulfill(transferId, fulfillment)) {
      transfer.account = transfer.from
      this.emitAsync('incoming_fulfill', transfer, fulfillment)

      const claim = yield this._rpc.call('fulfill_condition', this._prefix, [
        transferId, fulfillment
      ])

      yield this._incomingChannel.receive(transfer, claim)
      yield this._inFlight.sub(transfer.amount)
    }
  }

  * _handleFulfillCondition (transferId, fulfillment, claim) {
    this._validator.validateFulfillment(fulfillment)

    yield this._transfers.assertOutgoing(transferId)
    yield this._transfers.assertAllowedChange(transferId, 'executed')
    const transfer = yield this._transfers.get(transferId)
    debug('outgoing transfer fulfilled by peer:', transfer)

    this._validateFulfillment(fulfillment, transfer)

    if (yield this._transfers.fulfill(transferId, fulfillment)) {
      transfer.account = transfer.to
      this.emitAsync('outgoing_fulfill', transfer, fulfillment)

      // gets the claim from the outgoing channel
      return yield this._outgoingChannel.send(transfer)
    }
  }

  * _rejectIncomingTransfer (transferId, reason) {
    const transfer = yield this._transfers.get(transferId)
    debug('rejecting incoming transfer:', transferId, reason)

    yield this._transfers.assertIncoming(transferId)
    if (yield this._transfers.cancel(transferId)) {
      this.emitAsync('incoming_reject', transfer, reason)
    }
    debug('rejected:', transferId)

    yield this._balance.sub(transfer.amount)
    yield this._rpc.call('reject_incoming_transfer', this._prefix, [transferId, reason])
  }

  * _handleRejectIncomingTransfer (transferId, reason) {
    const transfer = yield this._transfers.get(transferId)

    yield this._transfers.assertOutgoing(transferId)
    if (yield this._transfers.cancel(transferId)) {
      this.emitAsync('outgoing_reject', transfer, reason)
    }

    return true
  }

  _validateFulfillment (fulfillment, transfer) {
    if (base64url(util.sha256(fulfillment)) !== transfer.executionCondition) {
      throw new Errors.NotAcceptedError('fulfillment (', fulfillment,
        ') does not match condition (', transfer.executionCondition, ')')
    }
  }

  * _sendMessage (rawMessage) {
    const message = Object.assign({
      from: this.getAccount(),
      ledger: this._prefix
    }, rawMessage)

    if (message.account) {
      message.to = message.account
    }

    this._validator.validateOutgoingMessage(message)
    yield this._rpc.call('send_message', this._prefix, [ message ])
    this.emitAsync('outgoing_message', message)
  }

  * _handleSendMessage (message) {
    this._validator.validateIncomingMessage(message)
    // TODO: is yielding to event emitters a good idea in RPC calls?
    message.account = message.from
    this.emitAsync('incoming_message', message)

    return true
  }

  * _getFulfillment (transferId) {
    return yield this._transfers.getFulfillment(transferId)
  }

  * _setupExpire (transferId, expiresAt) {
    const expiry = Date.parse(expiresAt)
    const now = new Date()

    const that = this
    setTimeout(
      co.wrap(this._expire).bind(this, transferId),
      (expiry - now))
  }

  * _expire (transferId) {
    debug('checking expiry of:', transferId)

    const packaged = yield this._transfers._getPackaged(transferId)

    // don't cancel again if it's already cancelled/executed
    try {
      if (!(yield this._transfers.cancel(transferId))) {
        debug(transferId + ' is already cancelled')
        return
      }
    } catch (e) {
      debug(e.message)
      return
    }

    if (packaged.isIncoming) {
      yield this._inFlight.sub(packaged.transfer.amount)
    }

    this.emitAsync((packaged.isIncoming ? 'incoming' : 'outgoing') + '_cancel',
      packaged.transfer)
  }
}
