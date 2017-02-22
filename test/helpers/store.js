'use strict'

module.exports = class Store {
  constructor () {
    this._store = {}
  }

  get (k) {
    return Promise.resolve(this._store[k])
  }

  put (k, v) {
    this._store[k] = v
    return Promise.resolve(null)
  }

  del (k) {
    delete this._store[k]
    return Promise.resolve(null)
  }
}
