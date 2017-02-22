'use strict'
const errors = require('../util/errors')
const TransferNotFoundError = errors.TransferNotFoundError
const TransferNotConditionalError = errors.TransferNotConditionalError
const DuplicateIdError = errors.DuplicateIdError
const NotAcceptedError = errors.NotAcceptedError
const AlreadyRolledBackError = errors.AlreadyRolledBackError
const AlreadyFulfilledError = errors.AlreadyFulfilledError
const MissingFulfillmentError = errors.MissingFulfillmentError
const debug = require('debug')('ilp-plugin-virtual:store')

module.exports = class TransferLog {

  constructor (opts) {
    this._store = opts.store

    this._cacheItems = {}
    this._cacheStack = []
    this._cacheSize = 500

    this.incoming = 'incoming'
    this.outgoing = 'outgoing'
  }

  * get (transferId) {
    return (yield this._getPackaged(transferId)).transfer
  }

  * getFulfillment (transferId) {
    const packaged = yield this._getPackaged(transferId)

    if (!packaged.transfer.executionCondition) {
      throw new TransferNotConditionalError('transfer with id ' + transferId +
        ' is not conditional')
    } else if (packaged.state === 'cancelled') {
      throw new AlreadyRolledBackError('transfer with id ' + transferId +
        ' has already been rolled back')
    } else if (packaged.state === 'prepared') {
      throw new MissingFulfillmentError('transfer with id ' + transferId +
        ' has not been fulfilled')
    }

    return packaged.fulfillment
  }

  * fulfill (transferId, fulfillment) {
    debug('fulfilling with ' + fulfillment)
    return yield this._setState(transferId, 'executed', fulfillment)
  }

  * cancel (transferId) {
    return yield this._setState(transferId, 'cancelled', null)
  }

  * drop (transferId) {
    this._removeFromCache(transferId)
    this._store.del('transfer_' + transferId)
  }

  // returns whether or not the state changed
  * _setState (transferId, state, fulfillment) {
    const existingTransfer = yield this._getPackaged(transferId)
    if (!(yield this.assertAllowedChange(transferId, state))) {
      return false
    }

    existingTransfer.state = state
    existingTransfer.fulfillment = fulfillment

    yield this._storePackaged(existingTransfer)
    return true
  }

  * storeIncoming (transfer) {
    return yield this._storeTransfer(transfer, true)
  }

  * storeOutgoing (transfer) {
    return yield this._storeTransfer(transfer, false)
  }

  * _storeTransfer (transfer, isIncoming) {
    const stored = yield this._safeGet(transfer.id)

    if (stored && !deepEqual(transfer, stored)) {
      throw new DuplicateIdError('transfer ' +
        JSON.stringify(transfer) +
        ' matches the id of ' +
        JSON.stringify(stored) +
        ' but not the contents.')
    } else if (stored) {
      return false
    }

    debug('stored ' + transfer.id, 'isIncoming', isIncoming)
    yield this._storePackaged({
      transfer: transfer,
      state: (transfer.executionCondition ? 'prepared' : 'executed'),
      isIncoming: isIncoming
    })

    return true
  }

  * _storePackaged (packaged) {
    this._storeInCache(packaged)
    this._store.put('transfer_' + packaged.transfer.id, JSON.stringify(packaged))
  }

  * assertIncoming (transferId) {
    yield this._assertDirection(transferId, true)
  }

  * assertOutgoing (transferId) {
    yield this._assertDirection(transferId, false)
  }

  * _assertDirection (transferId, isIncoming) {
    const packaged = yield this._getPackaged(transferId)

    if (packaged.isIncoming !== isIncoming) {
      debug('is incoming?', packaged.isIncoming, 'looking for', isIncoming)
      throw new NotAcceptedError('transfer with id ' + transferId + ' is not ' +
        (isIncoming ? 'incoming' : 'outgoing'))
    }
  }

  * assertAllowedChange (transferId, targetState) {
    const packaged = yield this._getPackaged(transferId)

    // top priority is making sure not to change an optimistic
    if (!packaged.transfer.executionCondition) {
      throw new TransferNotConditionalError('transfer with id ' + transferId + ' is not conditional')
    // next priority is to silently return if the change has already occurred
    } else if (packaged.state === targetState) {
      return false
    } else if (packaged.state === 'executed') {
      throw new AlreadyFulfilledError('transfer with id ' + transferId + ' has already executed')
    } else if (packaged.state === 'cancelled') {
      throw new AlreadyRolledBackError('transfer with id ' + transferId + ' has already rolled back')
    }

    return true
  }

  * _safeGet (transferId) {
    try {
      return yield this.get(transferId)
    } catch (e) {
      return null
    }
  }

  * _getPackaged (transferId) {
    // try to retreive from cache
    if (this._cacheItems[transferId]) {
      return this._cacheItems[transferId]
    }

    const packaged = yield this._store.get('transfer_' + transferId)
    if (!packaged) {
      throw new TransferNotFoundError('no transfer with id ' + transferId + ' was found.')
    }
    return JSON.parse(packaged)
  }

  _removeFromCache (transferId) {
    delete this._cacheItems[transferId]
    this._cacheStack.splice(this._cacheStack.indexOf(transferId), 1)
  }

  _storeInCache (packaged) {
    this._cacheStack.push(packaged.transfer.id)
    this._cacheItems[packaged.transfer.id] = packaged
    if (this._cacheItems.length > this._cacheSize) {
      this._cacheItems.shift()
    }
  }
}

const deepEqual = (a, b) => {
  return deepContains(a, b) && deepContains(b, a)
}

const deepContains = (a, b) => {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  for (let k of Object.keys(a)) {
    if (a[k] && typeof a[k] === 'object') {
      if (!deepContains(a[k], b[k])) {
        return false
      }
    } else if (a[k] !== b[k]) {
      return false
    }
  }
  return true
}
