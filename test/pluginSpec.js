'use strict' /* eslint-env mocha */

const Plugin = require('..')
const Store = require('ilp-store-memory')
const BtpPacket = require('btp-packet')
const { util } = require('ilp-plugin-xrp-paychan-shared')
const sodium = require('sodium-universal')
const { MoneyNotSentError } = require('../src/lib/constants')

const EventEmitter = require('events')
const chai = require('chai')
const chaiAsPromised = require('chai-as-promised')
chai.use(chaiAsPromised)
const sinon = require('sinon')
const sinonChai = require('sinon-chai')
chai.use(sinonChai)

const assert = chai.assert

// peer secretn spCWi5W9SmYYsaDin9Zqe64C27i

describe('Plugin XRP Paychan Symmetric', function () {
  beforeEach(function () {
    this.sinon = sinon.sandbox.create()
    this.plugin = new Plugin({
      xrpServer: 'wss://s.altnet.rippletest.net:51233',
      secret: 'sahNtietWCRzmX7Z2Zy7Z3EsvFDjv',
      address: 'ra3h9tzcipHTZCdQesMthfx4iBZNEEuHXG',
      peerAddress: 'rKwCnwtM6et7BVaCZm97hbU8oXkoohReea',
      _store: new Store()
    })

    this.encodeStub = this.sinon.stub(util, 'encodeClaim').returns('abcdefg')
    this.sinon.stub(sodium, 'crypto_sign_detached').returns('abcdefg')

    this.ilpData = {
      protocolData: [{
        protocolName: 'ilp',
        contentType: BtpPacket.MIME_APPLICATION_OCTET_STREAM,
        data: Buffer.alloc(0)
      }]
    }

    this.channel = {
      settleDelay: util.MIN_SETTLE_DELAY + 1,
      destination: this.plugin._address,
      publicKey: 'abcdefg',
      balance: '100',
      amount: '1000'
    }

    this.submitterStub = this.sinon.stub(this.plugin._txSubmitter, 'submit').resolves({
      transaction: {
        Account: 'ra3h9tzcipHTZCdQesMthfx4iBZNEEuHXG',
        Destination: 'rKwCnwtM6et7BVaCZm97hbU8oXkoohReea',
        Sequence: 1
      }
    })
  })

  afterEach(function () {
    this.sinon.restore()
  })

  describe('constructor', function () {
    beforeEach(function () {
      this.opts = {
        xrpServer: 'wss://s.altnet.rippletest.net:51233',
        secret: 'sahNtietWCRzmX7Z2Zy7Z3EsvFDjv',
        address: 'ra3h9tzcipHTZCdQesMthfx4iBZNEEuHXG',
        peerAddress: 'rKwCnwtM6et7BVaCZm97hbU8oXkoohReea',
        _store: new Store()
      }
    })

    it('should throw an error on non-number currencyScale', function () {
      this.opts.currencyScale = 'foo'
      assert.throws(() => new Plugin(this.opts),
        /currency scale must be a number if specified/)
    })

    it('should not throw an error on number currencyScale', function () {
      this.opts.currencyScale = 6
      const plugin = new Plugin(this.opts)
      assert.isOk(plugin)
    })
  })

  describe('_handleData', function () {
    describe('ilp data', function () {
      beforeEach(function () {
        this.plugin._paychanReady = true
        this.plugin._incomingChannel = 'ASDF1234'
      })

      it('should throw if paychan is not ready', async function () {
        this.plugin._paychanReady = false
        await assert.isRejected(this.plugin._handleData(null, {
          requestId: 1,
          data: this.ilpData
        }), /paychan initialization has not completed or has failed/)
      })

      it('should handle ilp data', async function () {
        let handled = false
        this.plugin.registerDataHandler(data => {
          assert.deepEqual(data, Buffer.alloc(0))
          handled = true
          return Buffer.from('test_result')
        })

        const result = await this.plugin._handleData(null, {
          requestId: 1,
          data: this.ilpData
        })

        assert.isTrue(handled, 'handler should have been called')
        assert.deepEqual(result, [{
          protocolName: 'ilp',
          contentType: BtpPacket.MIME_APPLICATION_OCTET_STREAM,
          data: Buffer.from('test_result')
        }], 'result should contain the buffer returned by data handler')
      })

      it('should throw an error if there is no data handler', function () {
        return assert.isRejected(this.plugin._handleData(null, {
          requestId: 1,
          data: this.ilpData
        }), /no request handler registered/)
      })

      it('should throw an error if there is no ilp data', async function () {
        this.plugin.registerDataHandler(() => {})

        await assert.isRejected(this.plugin._handleData(null, {
          requestId: 1,
          data: { protocolData: [] }
        }), /no ilp protocol on request/)
      })
    })

    describe('xrp_address subprotocol', function () {
      beforeEach(function () {
        this.plugin._paychanReady = true
        this.plugin._incomingChannel = 'ASDF1234'
        this.setPeerAddressStub = this.sinon.stub(this.plugin, '_setPeerAddress')
      })

      it('should handle xrp_address request', async function () {
        const result = await this.plugin._handleData(null, {
          requestId: 1,
          data: {
            protocolData: [{
              protocolName: 'xrp_address',
              contentType: BtpPacket.MIME_TEXT_PLAIN_UTF8,
              data: Buffer.from('peer_xrp_address')
            }]
          }
        })

        assert.deepEqual(result, [{
          protocolName: 'xrp_address',
          contentType: BtpPacket.MIME_TEXT_PLAIN_UTF8,
          data: Buffer.from(this.plugin._address)
        }])
        assert.isTrue(this.setPeerAddressStub.calledWith('peer_xrp_address'))
      })
    })

    describe('info subprotocol', function () {
      beforeEach(function () {
        this.plugin._paychanReady = true
        this.plugin._incomingChannel = 'ASDF1234'
      })

      it('should handle info request', async function () {
        const result = await this.plugin._handleData(null, {
          requestId: 1,
          data: {
            protocolData: [{
              protocolName: 'info',
              contentType: BtpPacket.MIME_APPLICATION_OCTET_STREAM,
              data: Buffer.from([ util.INFO_REQUEST_ALL ])
            }]
          }
        })

        assert.deepEqual(result, [{
          protocolName: 'info',
          contentType: BtpPacket.MIME_APPLICATION_JSON,
          data: Buffer.from(JSON.stringify({ currencyScale: 6 }))
        }])
      })
    })

    describe('ripple_channel_id subprotocol', function () {
      beforeEach(function () {
        this.plugin._paychanReady = true
        this.getPaymentChannelStub = this.sinon.stub(this.plugin._api, 'getPaymentChannel').resolves(this.channel)
        this.validateChannelDetailsStub = this.sinon.stub(this.plugin, '_validateChannelDetails').returns()
        this.channelIdRequest = {
          requestId: 1,
          data: {
            protocolData: [{
              protocolName: 'ripple_channel_id',
              contentType: BtpPacket.MIME_TEXT_PLAIN_UTF8,
              data: Buffer.from('peer_channel_id')
            }]
          }
        }
        this.sinon.stub(this.plugin, '_call').rejects(new Error('info protocol is not supported'))
        this.plugin._incomingClaim = {
          amount: '100',
          signature: 'some signature'
        }

        // no need to look at the ledger in this test
        this.claimStub = this.sinon.stub(this.plugin, '_claimFunds').resolves()
        this.watchStub = this.sinon.stub(this.plugin._watcher, 'watch').resolves()
        this.plugin._outgoingChannel = 'my_channel_id'
      })

      it('should handle ripple_channel_id protocol', async function () {
        const result = await this.plugin._handleData(null, this.channelIdRequest)

        assert.equal(this.plugin._incomingChannel, 'peer_channel_id', 'incoming channel should be set')
        assert.deepEqual(this.plugin._incomingChannelDetails, this.channel, 'incoming channel details should be set')
        assert.isTrue(this.watchStub.called, 'should be watching channel')
        assert.deepEqual(result, [{
          protocolName: 'ripple_channel_id',
          contentType: BtpPacket.MIME_TEXT_PLAIN_UTF8,
          data: Buffer.from(this.plugin._outgoingChannel)
        }], 'result should contain outgoing channel')
      })

      it('should throw on invalid channel details', async function () {
        // no need to look at the ledger in this test
        this.validateChannelDetailsStub.throws()

        await assert.isRejected(this.plugin._handleData(null, this.channelIdRequest), /Error/)
        assert.equal(this.plugin._incomingChannel, null, 'incoming channel should not be set')
      })

      it('should not race two requests', async function () {
        const storeSpy = sinon.spy(this.plugin._store, 'set').withArgs('incoming_channel')
        await Promise.all([
          this.plugin._handleData(null, this.channelIdRequest),
          this.plugin._handleData(null, this.channelIdRequest)
        ])

        assert.equal(storeSpy.callCount, 1,
          'incoming channel should only be written once to the store, otherwise there was a race')
      })

      it('should reset existing channel with ripple_channel_id, after claiming', async function () {
        // no need to look at the ledger in this test
        this.plugin._incomingChannel = 'peer_channel_id'
        this.plugin._outgoingChannel = 'my_channel_id'

        this.channelIdRequest.data.protocolData[0].data = Buffer.from('fake_peer_channel_id')
        await this.plugin._handleData(null, this.channelIdRequest)

        assert.equal(this.plugin._incomingChannel, 'fake_peer_channel_id', 'incoming channel should be set')
        assert.isTrue(this.watchStub.called, 'should be watching new channel')
        assert.isFalse(this.claimStub.called, 'should not have issued claim')
      })

      it('should issue claim is there are unclaimed funds while resetting channel id', async function () {
        // no need to look at the ledger in this test
        this.plugin._incomingChannel = 'peer_channel_id'
        this.plugin._outgoingChannel = 'my_channel_id'

        // set claim amount higher than channel balance
        this.plugin._incomingClaim.amount = '101000000'

        this.channelIdRequest.data.protocolData[0].data = Buffer.from('fake_peer_channel_id')
        await this.plugin._handleData(null, this.channelIdRequest)

        assert.equal(this.plugin._incomingChannel, 'fake_peer_channel_id', 'incoming channel should be set')
        assert.isTrue(this.watchStub.called, 'should be watching new channel')
        assert.isTrue(this.claimStub.called, 'should have issued claim')
      })

      it('should continue if a claim cannot be performed', async function () {
        // no need to look at the ledger in this test
        this.plugin._incomingChannel = 'peer_channel_id'
        this.plugin._outgoingChannel = 'my_channel_id'
        this.claimStub.rejects(new Error('error!'))

        // set claim amount higher than channel balance
        this.plugin._incomingClaim.amount = '101000000'

        this.channelIdRequest.data.protocolData[0].data = Buffer.from('fake_peer_channel_id')
        await this.plugin._handleData(null, this.channelIdRequest)

        assert.equal(this.plugin._incomingChannel, 'fake_peer_channel_id', 'incoming channel should be set')
        assert.isTrue(this.watchStub.called, 'should be watching new channel')
        assert.isTrue(this.claimStub.called, 'should have issued claim')
      })

      it('should not allow ILP packets while channel is reloading', async function () {
        // no need to look at the ledger in this test
        this.plugin._incomingChannel = 'peer_channel_id'
        this.plugin._outgoingChannel = 'my_channel_id'

        let claimAssertionSucceeded = false
        this.claimStub.callsFake(async () => {
          await assert.isRejected(this.plugin._handleData(null, {
            requestId: 1,
            data: this.ilpData
          }), /channel details are being reloaded/)
          claimAssertionSucceeded = true
        })

        // set claim amount higher than channel balance
        this.plugin._incomingClaim.amount = '101000000'

        this.channelIdRequest.data.protocolData[0].data = Buffer.from('fake_peer_channel_id')
        await this.plugin._handleData(null, this.channelIdRequest)

        assert.equal(this.plugin._incomingChannel, 'fake_peer_channel_id', 'incoming channel should be set')
        assert.isTrue(this.watchStub.called, 'should be watching new channel')
        assert.isTrue(this.claimStub.called, 'should have issued claim')
        assert.isTrue(claimAssertionSucceeded)
      })

      it('should not reset channel when the channel stays the same', async function () {
        // no need to look at the ledger in this test
        this.plugin._incomingChannel = 'peer_channel_id'
        this.plugin._outgoingChannel = 'my_channel_id'

        await this.plugin._setIncomingChannel('peer_channel_id')

        assert.equal(this.plugin._incomingChannel, 'peer_channel_id', 'incoming channel should not change')
        assert.isFalse(this.watchStub.called, 'should be watching new channel')
        assert.isFalse(this.claimStub.called, 'should not have issued claim')
      })
    })
  })

  describe('_reloadIncomingChannelDetails', function () {
    beforeEach(function () {
      this.plugin._outgoingChannel = 'my_channel_id'

      this.callStub = this.sinon.stub(this.plugin, '_call')
      this.callStub.callsFake(async (...args) => {
        const {protocolMap} = this.plugin.protocolDataToIlpAndCustom(args[1].data)
        if (protocolMap.ripple_channel_id) {
          return {
            protocolData: [{
              protocolName: 'ripple_channel_id',
              contentType: BtpPacket.MIME_TEXT_PLAIN_UTF8,
              data: Buffer.from('peer_channel_id')
            }]
          }
        } else if (protocolMap.info) {
          return this.callStub.__info()
        }
      })

      // bind to callStub so that we can change this function for the high
      // scale version
      this.callStub.__info = () => {
        throw new Error('info protocol is not supported')
      }

      this.getChanStub = this.sinon.stub(this.plugin._api, 'getPaymentChannel').resolves(this.channel)
      this.sinon.stub(this.plugin._watcher.api, 'connect').resolves()
    })

    it('should return if it cannot query the peer for a channel', async function () {
      // simulate the plugin not being able to get incoming channel
      this.callStub.resolves({ protocolData: [] })

      await this.plugin._reloadIncomingChannelDetails()

      assert.isTrue(this.callStub.called, 'should have tried to query peer for balance')
      assert.isTrue(this.getChanStub.notCalled, 'should not have reached getPaymentChannel')
    })

    it('should return if getPaymentChannel gives a rippled error', async function () {
      this.plugin._incomingChannel = 'peer_channel_id'
      this.getChanStub.rejects(new Error('errrror!'))
      await this.plugin._reloadIncomingChannelDetails()
      assert.isTrue(this.getChanStub.called, 'should have queried ledger for paychan')
    })

    it('should set last claimed amount', async function () {
      this.plugin._incomingChannel = 'peer_channel_id'
      this.getChanStub.resolves(this.channel)
      await this.plugin._reloadIncomingChannelDetails()
      assert.isTrue(this.getChanStub.called, 'should have queried ledger for paychan')
      assert.equal(this.plugin._lastClaimedAmount.toString(), this.plugin.xrpToBase(this.channel.balance))
    })

    it('should throw if settleDelay is too soon', async function () {
      this.plugin._incomingChannel = null
      this.channel.settleDelay = util.MIN_SETTLE_DELAY - 1

      await assert.isRejected(this.plugin._reloadIncomingChannelDetails(),
        /settle delay of incoming payment channel too low/)
    })

    it('should throw if cancelAfter is specified', async function () {
      this.channel.cancelAfter = Date.now() + 1000
      await assert.isRejected(this.plugin._reloadIncomingChannelDetails(),
        /cancelAfter must not be set/)
    })

    it('should throw if expiration is specified', async function () {
      this.channel.expiration = Date.now() + 1000
      await assert.isRejected(this.plugin._reloadIncomingChannelDetails(),
        /expiration must not be set/)
    })

    it('should throw if destination does not match our account', async function () {
      this.channel.destination = this.plugin._peerAddress
      await assert.isRejected(this.plugin._reloadIncomingChannelDetails(),
        /Channel destination address wrong/)
    })

    it('should setup auto claim if all details are ok', async function () {
      const clock = sinon.useFakeTimers({toFake: ['setInterval']})
      this.sinon.stub(this.plugin._api, 'getFee').resolves('0.000001')

      await this.plugin._reloadIncomingChannelDetails()
      assert.isTrue(!!this.plugin._claimIntervalId,
        'claim interval should be started if reload was successful')

      this.plugin._incomingClaim = {
        amount: this.plugin._lastClaimedAmount.plus(101).toString()
      }
      const stub = sinon.stub(this.plugin, '_claimFunds').resolves()

      clock.tick(util.DEFAULT_CLAIM_INTERVAL)
      await new Promise(resolve => setImmediate(resolve))

      assert(stub.calledOnce, 'Expected claimFunds to be called once')
      clock.restore()
    })

    it('should not auto claim if fee is too high', async function () {
      const clock = sinon.useFakeTimers({toFake: ['setInterval']})
      this.sinon.stub(this.plugin._api, 'getFee').resolves('0.000011')

      await this.plugin._reloadIncomingChannelDetails()
      assert.isTrue(!!this.plugin._claimIntervalId,
        'claim interval should be started if reload was successful')

      this.plugin._incomingClaim = {
        amount: this.plugin._lastClaimedAmount.plus(1000).toString()
      }
      const stub = sinon.stub(this.plugin, '_claimFunds').resolves()

      clock.tick(util.DEFAULT_CLAIM_INTERVAL)
      await new Promise(resolve => setImmediate(resolve))

      assert.isFalse(stub.called, 'claim should not have been called')
      clock.restore()
    })

    describe('with high scale', function () {
      beforeEach(function () {
        this.plugin._currencyScale = 9
        this.plugin._channelAmount = 1e9
        this.plugin._outgoingClaim = {
          amount: '990',
          signature: '61626364656667'
        }

        this.callStub.__info = () => ({
          protocolData: [{
            protocolName: 'info',
            contentType: BtpPacket.MIME_APPLICATION_JSON,
            data: Buffer.from(JSON.stringify({ currencyScale: 9 }))
          }]
        })
      })

      it('should use correct units when determining if claim is profitable', async function () {
        const clock = sinon.useFakeTimers({toFake: ['setInterval']})
        this.sinon.stub(this.plugin._api, 'getFee').resolves('0.000010')

        await this.plugin._reloadIncomingChannelDetails()
        assert.isTrue(!!this.plugin._claimIntervalId,
          'claim interval should be started if reload was successful')

        this.plugin._incomingClaim = {
          amount: this.plugin._lastClaimedAmount.plus(1000000).toString()
        }

        const stub = sinon.stub(this.plugin, '_claimFunds').resolves()
        const spy = sinon.spy(this.plugin, '_isClaimProfitable')

        clock.tick(util.DEFAULT_CLAIM_INTERVAL)
        await new Promise(resolve => setImmediate(resolve))

        assert(stub.calledOnce, 'Expected claimFunds to be called once')
        assert(spy.calledOnce, 'Expected profitability to be checked')

        this.plugin._incomingClaim = {
          amount: this.plugin._lastClaimedAmount.plus(999999).toString()
        }

        clock.tick(util.DEFAULT_CLAIM_INTERVAL)
        await new Promise(resolve => setImmediate(resolve))

        assert(stub.calledOnce, 'Expected claimFunds to still only be called once')
        assert(spy.calledTwice, 'Expected profitability to be checked twice')
        clock.restore()
      })
    })
  })

  describe('_getPeerInfo', function () {
    beforeEach(function () {
      this.plugin._incomingChannel = 'peer_channel_id'
      this.plugin._currencyScale = 9

      this.callStub = this.sinon.stub(this.plugin, '_call')
    })

    it('should throw an error if the peer doesn\'t support info', async function () {
      this.callStub.rejects(new Error('no ilp protocol on request'))

      return assert.isRejected(this.plugin._getPeerInfo(),
        /peer is unable to accomodate our currencyScale; they are on an out of date version of this plugin/)
    })

    it('should not throw an error if the peer doesn\'t support info but our scale is 6', function () {
      this.plugin._currencyScale = 6
      this.callStub.rejects(new Error('no ilp protocol on request'))

      return assert.isFulfilled(this.plugin._getPeerInfo())
    })

    it('should throw an error if the peer scale does not match ours', function () {
      this.callStub.resolves({ protocolData: [{
        protocolName: 'info',
        contentType: BtpPacket.MIME_APPLICATION_JSON,
        data: Buffer.from(JSON.stringify({ currencyScale: 8 }))
      }]})

      return assert.isRejected(this.plugin._getPeerInfo(),
        /Fatal! Currency scale mismatch./)
    })

    it('should succeed if scales match', async function () {
      this.callStub.resolves({ protocolData: [{
        protocolName: 'info',
        contentType: BtpPacket.MIME_APPLICATION_JSON,
        data: Buffer.from(JSON.stringify({ currencyScale: 9 }))
      }]})

      return assert.isFulfilled(this.plugin._getPeerInfo())
    })
  })

  describe('_connect', function () {
    beforeEach(function () {
      // mock out the rippled connection
      this.plugin._api.connection = new EventEmitter()
      this.plugin._api.connection.request = () => Promise.resolve(null)
      this.plugin._keyPair = {
        publicKey: Buffer.alloc(sodium.crypto_sign_PUBLICKEYBYTES),
        secretKey: Buffer.alloc(sodium.crypto_sign_SECRETKEYBYTES)
      }
      this.sinon.stub(this.plugin._api, 'connect').resolves(null)

      this.channelId = '945BB98D2F03DFA2AED810F8917B2BC344C0AA182A5DB506C16F84593C24244F'
      this.tagStub = this.sinon.stub(util, 'randomTag').returns(1)
      this.loadStub = this.sinon.stub(this.plugin._api, 'getPaymentChannel')
        .callsFake(id => {
          assert.equal(id, this.channelId)
          return Promise.resolve(this.channel)
        })
    })

    describe('high scale', function () {
      beforeEach(function () {
        this.plugin._currencyScale = 9
        this.plugin._channelAmount = 1e9
        this.plugin._outgoingClaim = {
          amount: '990',
          signature: '61626364656667'
        }
      })

      it('should use the right units for payment channel create', async function () {
        await this.plugin._connect()

        assert.isTrue(this.submitterStub.called, 'should have submitted tx to ledger')
        assert.deepEqual(this.submitterStub.firstCall.args, [
          'preparePaymentChannelCreate',
          {
            amount: '1.000000',
            destination: 'rKwCnwtM6et7BVaCZm97hbU8oXkoohReea',
            settleDelay: 3600,
            publicKey: 'ED0000000000000000000000000000000000000000000000000000000000000000',
            sourceTag: 1
          }
        ])
      })
    })

    it('should fetch peer address from peer', async function () {
      const xrpAddressStub = this.sinon.stub(this.plugin, '_sendXrpAddressRequest')
        .resolves({ protocolData: [
          {
            protocolName: 'xrp_address',
            data: Buffer.from('peer_xrp_address')
          }
        ]})

      const setAddressStub = this.sinon.stub(this.plugin, '_setPeerAddress')

      delete this.plugin._peerAddress

      await this.plugin._connect()
      assert.isTrue(xrpAddressStub.called)
      assert.isTrue(setAddressStub.calledWith('peer_xrp_address'))
    })

    it('should throw if peer address cannot be fetched', async function () {
      const xrpAddressStub = this.sinon.stub(this.plugin, '_sendXrpAddressRequest')
        .rejects(new Error('cannot get address from peer'))

      const setAddressStub = this.sinon.stub(this.plugin, '_setPeerAddress')

      delete this.plugin._peerAddress

      await assert.isRejected(this.plugin._connect(), /cannot get address from peer/)
      assert.isTrue(xrpAddressStub.called)
      assert.isFalse(setAddressStub.called)
    })

    it('should load outgoing channel if exists', async function () {
      this.plugin._store.load('outgoing_channel')
      this.plugin._store.set('outgoing_channel', this.channelId)

      await this.plugin._connect()

      assert.isTrue(this.loadStub.called, 'should have loaded outgoing channel')
    })

    it('should load incoming channel details even if incoming channel already exists', async function () {
      this.plugin._store.load('incoming_channel')
      this.plugin._store.set('incoming_channel', this.channelId)
      const spy = this.sinon.spy(this.plugin, '_reloadIncomingChannelDetails')

      await this.plugin._connect()

      assert.deepEqual(this.loadStub.firstCall.args, [ this.channelId ])
      assert.isTrue(spy.calledOnce)
    })

    it('should prepare a payment channel', async function () {
      await this.plugin._connect()

      assert.isTrue(this.plugin._paychanReady)
      assert.isTrue(this.tagStub.called, 'should have generated source tag')
      assert.isTrue(this.submitterStub.called, 'should have submitted tx to ledger')
      assert.isTrue(this.loadStub.called, 'should have loaded outgoing channel')
    })
  })

  describe('_claimFunds', function () {
    beforeEach(function () {
      this.plugin._incomingClaim = {
        amount: '100',
        signature: 'some signature'
      }

      this.plugin._incomingChannelDetails = this.channel
    })

    it('should return if incomingClaim has no signature', async function () {
      delete this.plugin._incomingClaim.signature
      await this.plugin._claimFunds()
      assert.isFalse(this.submitterStub.called, 'should not have prepared a claim tx with no signature')
    })

    it('should submit tx if incomingClaim is valid', async function () {
      await this.plugin._claimFunds()
      assert.isTrue(this.submitterStub.calledWith('preparePaymentChannelClaim'))
    })

    describe('high scale', function () {
      beforeEach(function () {
        this.plugin._currencyScale = 9
        this.plugin._incomingClaim = {
          amount: '3000',
          signature: 'some signature'
        }
      })

      it('should use the right units for payment channel create', async function () {
        await this.plugin._claimFunds()

        assert.isTrue(this.submitterStub.called, 'should have submitted tx to ledger')
        assert.deepEqual(this.submitterStub.firstCall.args, [
          'preparePaymentChannelClaim',
          {
            balance: '0.000003',
            channel: null,
            signature: 'SOME SIGNATURE',
            publicKey: 'abcdefg'
          }
        ])
      })
    })
  })

  describe('_disconnect', function () {
    beforeEach(function () {
      this.plugin._claimIntervalId = setInterval(() => {}, 5000)
      this.claimStub = this.sinon.stub(this.plugin, '_claimFunds')
      this.disconnectStub = this.sinon.stub(this.plugin._api, 'disconnect')
    })

    afterEach(function () {
      assert.isTrue(this.claimStub.called, 'should have claimed funds')
      assert.isTrue(this.disconnectStub.called, 'should have disconnected api')
    })

    it('should claim and disconnect the api', async function () {
      await this.plugin._disconnect()
    })

    it('should still disconnect if claim fails', async function () {
      this.claimStub.throws()
      await this.plugin._disconnect()
    })

    it('should still disconnect if api disconnect fails', async function () {
      this.disconnectStub.throws()
      await this.plugin._disconnect()
    })
  })

  describe('_sendMoney', function () {
    beforeEach(function () {
      this.plugin._funding = true // turn off the funding path
      this.plugin._keyPair = {
        publicKey: Buffer.alloc(sodium.crypto_sign_PUBLICKEYBYTES),
        secretKey: Buffer.alloc(sodium.crypto_sign_SECRETKEYBYTES)
      }
      this.plugin._outgoingChannel = 'my_channel_id'
      this.plugin._outgoingClaim = { amount: '0' }
      this.plugin._outgoingChannelDetails = {
        amount: '10'
      }
      this._outgoingClaim = {
        amount: '100',
        signature: '00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000'
      }
    })

    describe('with low scale', function () {
      beforeEach(function () {
        this.plugin._currencyScale = 2
        this.plugin._outgoingClaim = {
          amount: '9',
          signature: '61626364656667'
        }
      })

      it('should multiply base to get drops', async function () {
        this.sinon.stub(this.plugin, '_call').resolves(null)

        await this.plugin.sendMoney(2)

        assert.deepEqual(this.encodeStub.getCall(0).args, [ '110000', 'my_channel_id' ])
      })
    })

    describe('funding', function () {
      beforeEach(function () {
        this.plugin._funding = false
        this.fundStub = this.sinon.stub(util, 'fundChannel').resolves()
        this.sinon.stub(this.plugin, '_call').resolves(null)
        this.plugin._outgoingChannelDetails = {
          settleDelay: util.MIN_SETTLE_DELAY + 1,
          destination: this.plugin._address,
          publicKey: 'abcdefg',
          balance: '0',
          amount: '10'
        }
      })

      it('should not issue fund if claim is below threshold', async function () {
        const sendRippleChannelIdStub = this.sinon.stub(this.plugin, '_sendRippleChannelIdRequest')
        const reloadOutgoingStub = this.sinon.stub(this.plugin, '_reloadOutgoingChannelDetails')

        await this.plugin.sendMoney('5000000')
        assert.isFalse(this.fundStub.called, 'fund should not have been called')
        assert.isFalse(sendRippleChannelIdStub.called, 'should not tell peer to reload channel')
        assert.isFalse(reloadOutgoingStub.called, 'should not reload outgoing channel')
      })

      it('should issue fund if claim is above threshold', async function () {
        await this.plugin.sendMoney('5000001')
        assert.isTrue(this.fundStub.called, 'fund should have been called')
        assert.deepEqual(this.fundStub.firstCall.args, [{
          api: this.plugin._api,
          channel: 'my_channel_id',
          amount: '10000000',
          address: this.plugin._address,
          secret: this.plugin._secret
        }])
      })

      it('should reload details after fund', async function () {
        const sendRippleChannelIdStub = this.sinon.stub(this.plugin, '_sendRippleChannelIdRequest')
        const reloadOutgoingStub = this.sinon.stub(this.plugin, '_reloadOutgoingChannelDetails')

        await this.plugin.sendMoney('5000001')

        assert.isTrue(this.fundStub.called, 'fund should have been called')
        assert.isTrue(sendRippleChannelIdStub.called, 'should tell peer to reload channel')
        assert.isTrue(reloadOutgoingStub.called, 'should reload outgoing channel')
      })
    })

    describe('with high scale', function () {
      beforeEach(function () {
        this.plugin._currencyScale = 9
        this.plugin._outgoingClaim = {
          amount: '990',
          signature: '61626364656667'
        }
      })

      it('should round high-scale amount up to next drop', async function () {
        this.sinon.stub(this.plugin, '_call').resolves(null)

        await this.plugin.sendMoney(100)

        assert.deepEqual(this.encodeStub.getCall(0).args, [ '2', 'my_channel_id' ])
      })

      it('should keep error under a drop even on repeated roundings', async function () {
        this.sinon.stub(this.plugin, '_call').resolves(null)

        await this.plugin.sendMoney(100)
        await this.plugin.sendMoney(100)

        assert.deepEqual(this.encodeStub.getCall(0).args, [ '2', 'my_channel_id' ])
        assert.deepEqual(this.encodeStub.getCall(1).args, [ '2', 'my_channel_id' ])
      })
    })

    it('should throw an error signing a claim higher than channel amount', async function () {
      await assert.isRejected(this.plugin.sendMoney(11 * 10e6), MoneyNotSentError,
        /claim amount exceeds channel balance. claimAmount=110000000 channelAmount=10000000 channel=my_channel_id/)
    })

    it('should sign a claim and submit it to the other side', async function () {
      this.sinon.stub(this.plugin, '_call').callsFake((from, data) => {
        // forgive me
        assert.deepEqual(data.data.protocolData[0].data,
          Buffer.from(JSON.stringify(this._outgoingClaim)))
      })

      await this.plugin.sendMoney(100)
    })
  })

  describe('_handleMoney', function () {
    beforeEach(function () {
      this.plugin._paychanReady = true
      this.claimAmount = '100'
      this.claimSignature = 'abcdefg'
      this.claimData = () => ({
        amount: '100',
        protocolData: [{
          protocolName: 'claim',
          contentType: BtpPacket.MIME_APPLICATION_JSON,
          data: JSON.stringify({
            amount: this.claimAmount,
            signature: this.claimSignature
          })
        }]
      })

      this.plugin._incomingChannelDetails = this.channel
      this.plugin._incomingClaim = {
        amount: '0',
        signature: 'abcdefg'
      }

      this.soidumStub = this.sinon.stub(sodium, 'crypto_sign_verify_detached').returns(true)
    })

    it('throws an error if new claim is less than old claim', async function () {
      this.plugin._incomingClaim.amount = '100'
      await assert.isRejected(
        this.plugin._handleMoney(null, { requestId: 1, data: this.claimData() }),
        /new claim is less than old claim. new=100 old=100/)
    })

    it('throws an error if the signature is not valid', async function () {
      this.soidumStub.throws()
      await assert.isRejected(
        this.plugin._handleMoney(null, { requestId: 1, data: this.claimData() }),
        /got invalid claim signature abcdefg for amount 100 drops total/)
    })

    it('throws an error if the claim is for more than the channel capacity', async function () {
      this.plugin._incomingChannelDetails.amount = '0.000001'
      await assert.isRejected(
        this.plugin._handleMoney(null, { requestId: 1, data: this.claimData() }),
        /got claim for amount higher than channel balance. amount: 100 incoming channel amount: 1/)
    })

    it('calls the money handler on success', async function () {
      let handled = false
      this.plugin.registerMoneyHandler(amount => {
        assert.deepEqual(amount, '100')
        handled = true
        return Buffer.from('test_result')
      })

      await this.plugin._handleMoney(null, { requestId: 1, data: this.claimData() })

      assert.isTrue(handled, 'handler should have been called')
    })

    it('should handle a claim with high scale', async function () {
      this.claimAmount = 1160
      this.plugin._incomingClaim = {
        amount: '990',
        signature: 'some signature'
      }

      this.plugin._incomingChannel = 'abcdef'
      this.plugin._currencyScale = 9
      await this.plugin._handleMoney(null, {
        requestId: 1,
        data: this.claimData()
      })

      assert.deepEqual(this.encodeStub.getCall(0).args, [ '2', 'abcdef' ])
    })
  })
})
