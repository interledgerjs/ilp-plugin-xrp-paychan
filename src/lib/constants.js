'use strict'

const BigNumber = require('bignumber.js')

const STATE_NO_CHANNEL = '0'
const STATE_CREATING_CHANNEL = '1'
const STATE_CHANNEL = '2'
const POLLING_INTERVAL_OUTGOING_PAYCHAN = 5000
const MIN_SETTLE_DELAY = 60 * 60 // = 1h
const DEFAULT_WATCHER_INTERVAL = 1000 * 60 * 60 // 1 hour

const DROPS_PER_XRP = 1000000
const dropsToXrp = (drops) => new BigNumber(drops).div(DROPS_PER_XRP).toString()
const xrpToDrops = (xrp) => new BigNumber(xrp).mul(DROPS_PER_XRP).toString()

const sleep = (time) => new Promise((resolve) => setTimeout(resolve, time))

class MoneyNotSentError extends Error {
  constructor (...args) {
    super(...args)
    this.name = 'MoneyNotSentError'
  }
}

module.exports = {
  // helper functions
  MoneyNotSentError,
  sleep,
  dropsToXrp,
  xrpToDrops,
  // constants
  DEFAULT_WATCHER_INTERVAL,
  MIN_SETTLE_DELAY,
  POLLING_INTERVAL_OUTGOING_PAYCHAN,
  STATE_NO_CHANNEL,
  STATE_CREATING_CHANNEL,
  STATE_CHANNEL
}
