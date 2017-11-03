'use strict'

const EventEmitter = require('events').EventEmitter
const BigNumber = require('bignumber.js')

const PEER_PRIVATE_KEY = '69C7405BDA3D0FEC97238DF72F026A46E6DDF88B88BD07F4497141737BFB66921AC9FD5AA2A8B13C8D25464F5C410A29E9AEE094E4D4EEDBE66E33E8D14F06DA'
const PEER_PUBLIC_KEY = '1AC9FD5AA2A8B13C8D25464F5C410A29E9AEE094E4D4EEDBE66E33E8D14F06DA'

const xrpToDrops = (xrp) => new BigNumber(xrp).mul(1000000).toString()

class ApiMock {
  constructor (opts, ...args) {
    this._pluginOpts = opts
    this._preparedTransactions = []
    this._sequenceNumber = 1

    const self = this
    const ConnectionMock = class extends EventEmitter {
      request () { return Promise.resolve() }
      on (...args) {
        super.on(...args)
        const [name] = args
        setImmediate(() => {
          for (const ev of self._preparedTransactions) {
            this.emit(name, ev)
          }
          self._preparedTransactions = []
        })
      }
    }
    this.connection = new ConnectionMock()
  }

  connect () { return Promise.resolve() }

  preparePaymentChannelCreate (address, paymentChannelClaim, instructions) {
    this._preparedTransactions.push({
      transaction: {
        SourceTag: paymentChannelClaim.sourceTag,
        Account: address,
        Destination: paymentChannelClaim.destination,
        Sequence: this._sequenceNumber++
      }
    })
    return {
      txJSON: '"some JSON string"',
      insructions: {
        fee: 1,
        sequence: 1,
        maxLedgerVersion: null
      }
    }
  }

  preparePaymentChannelClaim (address, paymentChannelCreate, insructions) {
    this._preparedTransactions.push({
      transaction: {
        Account: address,
        Channel: paymentChannelCreate.channel,
        Balance: parseInt(xrpToDrops(paymentChannelCreate.balance))
      }
    })
    return {
      txJSON: '"some JSON string"',
      insructions: {
        fee: 1,
        sequence: 1,
        maxLedgerVersion: null
      }
    }
  }

  _addPreparedTransaction (address, tx) {

  }

  sign () {
    return {
      signedTransaction: '1234567890ABCDEF',
      id: '1234567812345678123456781234567812345678123456781234567812345678'
    }
  }

  submit () {
    return {
      resultCode: 'tesSUCCESS',
      resultMessage: 'workeeed'
    }
  }

  getPaymentChannel () {
    return {
      account: this._pluginOpts.address,
      destination: this._pluginOpts.peerAddress,
      amount: new BigNumber(this._pluginOpts.maxAmount).div(1000000),
      balance: 0,
      settleDelay: this._pluginOpts.settleDelay,
      publicKey: 'ED' + PEER_PUBLIC_KEY
    }
  }
}

/**
 * Ripple Lib Stub.
 *
 * @param  {[Object]} opts [The options of the plugin that will use this stub.]
 * @return {[Class ApiMock]} [A ripple lib stub bound to the passed in plugin options.]
 */
function makeApi (opts) {
  return ApiMock.bind(null, opts)
}

module.exports = {
  makeApi,
  PEER_PUBLIC_KEY,
  PEER_PRIVATE_KEY
}
