'use strict'

const Validator = require('../util/validator')
const crypto = require('crypto')
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
    this._rpc.addMethod('_get_channel', this._getChannel)
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

  // don't throw errors even if the event handler throws.
  // errors can prevent the balance from being updated correctly.
  _safeEmit () {
    try {
      this.emit.apply(this, arguments)
    } catch (err) {
      debug('error in handler for event', arguments, err)
    }
  }

  * _getBalance () {
    return (new BigNumber(yield this._outgoingChannel.getBalance()))
      .neg()
      .add(yield this._incomingChannel.getBalance())
      .toString()
  }

  * _connect () {
    debug('connecting to ripple API')

    // because connecting this plugin can take a long time, the options timeout
    // is disregarded.
    yield this._api.connect()
    yield this._api.connection.request({
      command: 'subscribe',
      accounts: [ this._address ]
    })
    yield this._outgoingChannel.create()

    // we need the RPC to start up before this promise will work
    let incomingChannel = yield this._store.get('channel_i')

    if (incomingChannel) debug('got incoming channel from store:', incomingChannel)
    while (!incomingChannel) {
      try {
        incomingChannel = yield this._rpc.call('_get_channel', this._prefix, [ 'get_channel' ])
        if (typeof incomingChannel !== 'string') {
          throw new Error('got non-string response:' + JSON.stringify(incomingChannel))
        }
        debug('got peer payment channel:', incomingChannel)
      } catch (e) {
        debug('get channel failed:', e.message)
      }
      yield util.wait(5000).catch(() => {})
    }

    yield this._incomingChannel.create({ channelId: incomingChannel })

    this._connected = true
    this._safeEmit('connect')
  }

  * _disconnect () {
    debug('claiming outstanding funds before disconnect...') 
    yield this._incomingChannel._claimFunds()
    debug('closing api connection')
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
      currencyScale: 6,
      currencyCode: 'XRP',
      connectors: [ this._prefix + this._peerAddress ]
    }
  }

  * _fund () {
    debug('notified of fund tx. reloading channel details')
    yield this._incomingChannel.reloadChannelDetails()
    return true
  }

  * _getChannel () {
    debug('incoming request for channel')
    return this._outgoingChannel.getChannelId()
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

    this._safeEmit('outgoing_prepare', transfer)
    yield this._setupExpire(transfer.id, transfer.expiresAt)
  }

  * _handleSendTransfer (transfer) {
    this._validator.validateIncomingTransfer(transfer)
    yield this._transfers.storeIncoming(transfer)
    debug('notified of incoming transfer:', transfer)

    debug('adding', transfer.amount, 'to in-flight for receive prepare')
    yield this._inFlight.add(transfer.amount)
    transfer.account = transfer.from
    this._safeEmit('incoming_prepare', transfer)
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
    debug('validated fulfillment')

    if (yield this._transfers.fulfill(transferId, fulfillment)) {
      transfer.account = transfer.from
      this._safeEmit('incoming_fulfill', transfer, fulfillment)

      debug('requesting claim from peer')
      const claim = yield this._rpc.call('fulfill_condition', this._prefix, [
        transferId, fulfillment
      ])

      debug('receive claim from peer:', claim)
      try {
        yield this._incomingChannel.receive(transfer, claim)
        debug('subtracting', transfer.amount, 'from in-flight for fulfill')
        yield this._inFlight.sub(transfer.amount)
      } catch (e) {
        debug('claiming error:', e.stack)
        debug('failed to claim. keeping transfer as in-flight.')
      }
    }
  }

  * _handleFulfillCondition (transferId, fulfillment, claim) {
    debug('validating fulfillment request for', transferId)
    this._validator.validateFulfillment(fulfillment)
    debug('fulfillment validated', transferId)

    yield this._transfers.assertOutgoing(transferId)
    yield this._transfers.assertAllowedChange(transferId, 'executed')
    const transfer = yield this._transfers.get(transferId)
    debug('outgoing transfer fulfilled by peer:', transfer)

    this._validateFulfillment(fulfillment, transfer)

    if (yield this._transfers.fulfill(transferId, fulfillment)) {
      transfer.account = transfer.to
      this._safeEmit('outgoing_fulfill', transfer, fulfillment)

      // gets the claim from the outgoing channel
      try {
        return yield this._outgoingChannel.send(transfer)
      } catch (e) {
        debug('claim generation error:', e.stack)
        throw e
      }
    }
  }

  * _rejectIncomingTransfer (transferId, reason) {
    const transfer = yield this._transfers.get(transferId)
    debug('rejecting incoming transfer:', transferId, reason)

    yield this._transfers.assertIncoming(transferId)
    if (yield this._transfers.cancel(transferId)) {
      this._safeEmit('incoming_reject', transfer, reason)
    }
    debug('rejected:', transferId)

    debug('subtracting', transfer.amount, 'from in-flight for reject')
    yield this._inFlight.sub(transfer.amount)
    yield this._rpc.call('reject_incoming_transfer', this._prefix, [transferId, reason])
  }

  * _handleRejectIncomingTransfer (transferId, reason) {
    const transfer = yield this._transfers.get(transferId)

    yield this._transfers.assertOutgoing(transferId)
    if (yield this._transfers.cancel(transferId)) {
      this._safeEmit('outgoing_reject', transfer, reason)
    }

    return true
  }

  _validateFulfillment (fulfillment, transfer) {
    const preimage = Buffer.from(fulfillment, 'base64')
    const hash = crypto.createHash('sha256').update(preimage).digest()

    if (base64url(hash) !== transfer.executionCondition) {
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
    this._safeEmit('outgoing_message', message)
  }

  * _handleSendMessage (message) {
    this._validator.validateIncomingMessage(message)
    // TODO: is yielding to event emitters a good idea in RPC calls?
    message.account = message.from
    this._safeEmit('incoming_message', message)

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
      debug('subtracting', transfer.amount, 'from in-flight for expiry')
      yield this._inFlight.sub(packaged.transfer.amount)
    }

    this._safeEmit((packaged.isIncoming ? 'incoming' : 'outgoing') + '_cancel',
      packaged.transfer)
  }
}
