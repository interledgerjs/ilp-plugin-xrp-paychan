'use strict'

const nock = require('nock')
const Store = require('./helpers/store')
const assert = require('chai').assert
const PluginPaychan = require('..')

describe('PluginPaychan', () => {
  beforeEach(function () {
    this.plugin = new PluginPaychan({
      // TODO: a mock for the ripple server/API
      server: 'wss://s.altnet.rippletest.net:51233',
      address: 'rGjwZgV18qZD6mnqGoCSwW3Q3HPd7MjQwR',
      secret: 'snBvGgqvesRaTdcEuTsK7kdBkCLpX',
      channelSecret: 'hunter2',
      // shu2PunVSHuEbAybaU1GRMZJXuvDg
      peerAddress: 'rwXvN6e2AZfgm5aVwy8M91B3Bb1igukeNQ',
      peerPublicKey: '32D2471DB72B27E3310F355BB33E339BF26F8392D5A93D3BC0FC3B566612DA0F0A',      
      rpcUri: 'https://example.com/rpc',
      maxInFlight: '10',
      channelAmount: '1000',
      _store: new Store(),
    })
  })

  describe('constructor', () => {
    it('should be a function', () => {
      assert.isFunction(PluginPaychan)
    })

    it('should construct an object', function () {
      assert.isObject(this.plugin)
    })
  })

  describe('sendMessage', () => {
    beforeEach(function () {
      this.message = {
        ledger: 'g.crypto.ripple.',
        to: 'g.crypto.ripple.rwXvN6e2AZfgm5aVwy8M91B3Bb1igukeNQ',
        from: 'g.crypto.ripple.rGjwZgV18qZD6mnqGoCSwW3Q3HPd7MjQwR',
        data: {
          message: 'test'
        }
      }
    })

    it('should send a message', function * () {
      const sent = nock('https://example.com')
        .post('/rpc?method=send_message&prefix=g.crypto.ripple.', [ this.message ])
        .reply(200, true)

      const notified = new Promise((resolve) =>
        this.plugin.on('outgoing_message', resolve))

      yield this.plugin.sendMessage(this.message)
      yield notified

      sent.done()
    })

    it('should receive a message', function * () {
      const tmp = this.message.to
      this.message.to = this.message.from
      this.message.from = tmp

      yield this.plugin.receive('send_message', [ this.message ])
    })
  })
})
