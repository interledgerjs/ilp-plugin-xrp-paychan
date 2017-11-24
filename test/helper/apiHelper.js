'use strict'

const assert = require('chai').assert
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
      engine_result: 'tesSUCCESS',
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

  preparePaymentChannelFund (address, paymentChannelFund, instructions) {
    this._preparedTransactions.push({
      engine_result: 'tesSUCCESS',
      transaction: {
        hash: '1234567812345678123456781234567812345678123456781234567812345678'
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

  getPaymentChannel (id) {
    if (id === '47888B7F7FFAD1B35C054E928FA249FBE2CE31758FB620A9D2B1505AAF52459C') {
      return { // outgoing channel
        account: this._pluginOpts.address,
        destination: this._pluginOpts.peerAddress,
        amount: new BigNumber(this._pluginOpts.maxAmount).div(1000000).toString(),
        balance: 0,
        settleDelay: this._pluginOpts.settleDelay,
        publicKey: 'ED' + PEER_PUBLIC_KEY
      }
    } else if (id === '1234567890ABCDEF') {
      return { // incoming channel
        account: this._pluginOpts.peerAddress,
        destination: this._pluginOpts.address,
        amount: new BigNumber(this._pluginOpts.maxAmount).div(1000000).toString(),
        balance: 0,
        settleDelay: this._pluginOpts.settleDelay,
        publicKey: 'ED' + PEER_PUBLIC_KEY

      }
    }
    assert.fail(0, 1, 'unknown channel id ' + id)
  }

  async disconnect () {}
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
