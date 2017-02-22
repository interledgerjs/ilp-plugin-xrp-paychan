'use strict'
const BigNumber = require('bignumber.js')
const debug = require('debug')('ilp-plugin-paychan:balance')
const EventEmitter = require('eventemitter2')

const errors = require('../util/errors')
const NotAcceptedError = errors.NotAcceptedError
const InvalidFieldsError = errors.InvalidFieldsError

module.exports = class Balance extends EventEmitter {
  constructor (opts) {
    super()

    this._maximum = new BigNumber(opts.maximum)
    this._store = opts.store
    this._cached = null
    // TODO: all reserved DB key prefixes ought to be 9 characters
    // so it lines up with 'transfer_'
    this._key = opts.name
  }

  * get () {
    return (yield this._getNumber()).toString()
  }

  * _getNumber () {
    if (this._cached) {
      return this._cached
    }

    const stored = yield this._store.get(this._key)

    if (!this._isNumber(stored)) {
      debug('stored balance (' + stored + ') is invalid. rewriting as 0.')
      yield this._store.put(this._key, '0')
      return new BigNumber('0')
    }

    this._cached = new BigNumber(stored)
    return new BigNumber(stored)
  }

  * add (number) {
    this._assertNumber(number)

    const balance = yield this._getNumber()
    if (balance.add(new BigNumber(number)).gt(this._maximum)) {
      throw new NotAcceptedError('adding amount (' + number +
        ') to balance (' + balance +
        ') exceeds maximum (' + this._maximum.toString() +
        ')')
    }

    this._cached = balance.add(new BigNumber(number))
    this._store.put(this._key, this._cached.toString())
    this.emitAsync('balance', this._cached.toString())
  }

  * sub (number) {
    this._assertNumber(number)
    this._cached = (yield this._getNumber()).sub(new BigNumber(number))
    this._store.put(this._key, this._cached.toString())
    this.emitAsync('balance', this._cached.toString())
  }

  * _assertNumber (number) {
    if (!this._isNumber(number)) {
      throw new InvalidFieldsError('"' + number + '" is not a number.')
    }
  }

  _isNumber (string) {
    try {
      return !!(new BigNumber(string))
    } catch (e) {
      debug('"' + string + '" is not a number.')
      return false
    }
  }
}
