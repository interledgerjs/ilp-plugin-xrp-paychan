'use strict'
const Plugin = require('..')
const Store = require('ilp-store-memory')
const BtpPacket = require('btp-packet')
const { util } = require('ilp-plugin-xrp-paychan-shared')
const nacl = require('tweetnacl')

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
    this.sinon.stub(nacl.sign, 'detached').returns('abcdefg')

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

    this.signStub = this.sinon.stub(this.plugin._api, 'sign').returns({ signedTransaction: '123' })

    this.submitStub = this.sinon.stub(this.plugin._api, 'submit').callsFake(() => {
      setImmediate(() => {
        this.plugin._api.connection.emit('transaction', {
          transaction: {
            Sequence: 1,
            SourceTag: 1,
            Account: this.plugin._address,
            Destination: this.plugin._peerAddress,
            Channel: null
          },
          engine_result: 'tesSUCCESS'
        })
      })
      return {
        resultCode: 'tesSUCCESS',
        resultMessage: 'Successful'
      }
    })
  })

  afterEach(function () {
    this.sinon.restore()
  })

  describe('_handleData', function () {
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

    it('should throw an error if there is no data handler', async function () {
      await assert.isRejected(this.plugin._handleData(null, {
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

    it('should handle ripple_channel_id protocol', async function () {
      // no need to look at the ledger in this test
      this.sinon.stub(this.plugin, '_reloadIncomingChannelDetails').callsFake(() => Promise.resolve())
      this.plugin._outgoingChannel = 'my_channel_id'

      const result = await this.plugin._handleData(null, {
        requestId: 1,
        data: {
          protocolData: [{
            protocolName: 'ripple_channel_id',
            contentType: BtpPacket.MIME_TEXT_PLAIN_UTF8,
            data: Buffer.from('peer_channel_id')
          }]
        }
      })

      assert.equal(this.plugin._incomingChannel, 'peer_channel_id', 'incoming channel should be set')
      assert.deepEqual(result, [{
        protocolName: 'ripple_channel_id',
        contentType: BtpPacket.MIME_TEXT_PLAIN_UTF8,
        data: Buffer.from(this.plugin._outgoingChannel)
      }], 'result should contain outgoing channel')
    })
  })

  describe('_reloadIncomingChannelDetails', function () {
    beforeEach(function () {
      this.plugin._outgoingChannel = 'my_channel_id'
      this.plugin._incomingChannel = 'peer_channel_id'
    })

    it('should return if it cannot query the peer for a channel', async function () {
      // simulate the plugin not being able to get incoming channel
      this.plugin._incomingChannel = null
      const stub = this.sinon.stub(this.plugin, '_call').callsFake(() => Promise.resolve({ protocolData: [] }))
      const spy = this.sinon.spy(this.plugin._api, 'getPaymentChannel')

      await this.plugin._reloadIncomingChannelDetails()

      assert.isTrue(stub.called, 'should have tried to query peer for balance')
      assert.isTrue(spy.notCalled, 'should not have reached getPaymentChannel')
    })

    it('should return if getPaymentChannel gives a rippled error', async function () {
      this.sinon.stub(this.plugin, '_call').rejects(new Error('info protocol is not supported'))
      const stub = this.sinon.stub(this.plugin._api, 'getPaymentChannel')
        .callsFake(() => {
          throw new Error('there was an error!')
        })

      await this.plugin._reloadIncomingChannelDetails()
      assert.isTrue(stub.called, 'should have queried ledger for paychan')
    })

    it('should throw if settleDelay is too soon', async function () {
      this.channel.settleDelay = util.MIN_SETTLE_DELAY - 1
      this.sinon.stub(this.plugin, '_call').rejects(new Error('info protocol is not supported'))
      this.sinon.stub(this.plugin._api, 'getPaymentChannel')
        .resolves(this.channel)

      await assert.isRejected(this.plugin._reloadIncomingChannelDetails(),
        /settle delay of incoming payment channel too low/)
    })

    it('should throw if cancelAfter is specified', async function () {
      this.channel.cancelAfter = Date.now() + 1000
      this.sinon.stub(this.plugin, '_call').rejects(new Error('info protocol is not supported'))
      this.sinon.stub(this.plugin._api, 'getPaymentChannel')
        .resolves(this.channel)

      await assert.isRejected(this.plugin._reloadIncomingChannelDetails(),
        /cancelAfter must not be set/)
    })

    it('should throw if expiration is specified', async function () {
      this.channel.expiration = Date.now() + 1000
      this.sinon.stub(this.plugin, '_call').rejects(new Error('info protocol is not supported'))
      this.sinon.stub(this.plugin._api, 'getPaymentChannel')
        .resolves(this.channel)

      await assert.isRejected(this.plugin._reloadIncomingChannelDetails(),
        /expiration must not be set/)
    })

    it('should throw if destination does not match our account', async function () {
      this.channel.destination = this.plugin._peerAddress
      this.sinon.stub(this.plugin, '_call').rejects(new Error('info protocol is not supported'))
      this.sinon.stub(this.plugin._api, 'getPaymentChannel')
        .resolves(this.channel)

      await assert.isRejected(this.plugin._reloadIncomingChannelDetails(),
        /Channel destination address wrong/)
    })

    it('should return if all details are ok', async function () {
      this.sinon.stub(this.plugin, '_call').rejects(new Error('info protocol is not supported'))
      this.sinon.stub(this.plugin._api, 'getPaymentChannel')
        .resolves(this.channel)

      await this.plugin._reloadIncomingChannelDetails()
      assert.isTrue(!!this.plugin._claimIntervalId,
        'claim interval should be started if reload was successful')
    })

    describe('with high scale', function () {
      beforeEach(function () {
        this.plugin._currencyScale = 9
      })

      it('should throw an error if the peer doesn\'t support info', async function () {
        this.sinon.stub(this.plugin, '_call')
          .rejects(new Error('no ilp protocol on request'))

        assert.isRejected(this.plugin._reloadIncomingChannelDetails(),
          /peer is unable to accomodate our currencyScale; they are on an out of date version of this plugin/)
      })

      it('should not throw an error if the peer doesn\'t support info but our scale is 6', async function () {
        this.plugin._currencyScale = 6
        this.sinon.stub(this.plugin, '_call')
          .rejects(new Error('no ilp protocol on request'))

        await this.plugin._reloadIncomingChannelDetails()
      })

      it('should throw an error if the peer scale does not match ours', async function () {
        this.sinon.stub(this.plugin, '_call')
          .resolves({ protocolData: [{
            protocolName: 'info',
            contentType: BtpPacket.MIME_APPLICATION_JSON,
            data: Buffer.from(JSON.stringify({ currencyScale: 8 }))
          }]})

        assert.isRejected(this.plugin._reloadIncomingChannelDetails(),
          /Fatal! Currency scale mismatch./)
      })

      it('should succeed if scales match', async function () {
        this.sinon.stub(this.plugin, '_call')
          .resolves({ protocolData: [{
            protocolName: 'info',
            contentType: BtpPacket.MIME_APPLICATION_JSON,
            data: Buffer.from(JSON.stringify({ currencyScale: 9 }))
          }]})

        this.sinon.stub(this.plugin._api, 'getPaymentChannel')
          .resolves(this.channel)

        await this.plugin._reloadIncomingChannelDetails()
        assert.isTrue(!!this.plugin._claimIntervalId,
          'claim interval should be started if reload was successful')
      })
    })
  })

  describe('_connect', function () {
    beforeEach(function () {
      // mock out the rippled connection
      this.plugin._api.connection = new EventEmitter()
      this.plugin._api.connection.request = () => Promise.resolve(null)
      this.sinon.stub(this.plugin._api, 'connect').resolves(null)

      this.channelId = '945BB98D2F03DFA2AED810F8917B2BC344C0AA182A5DB506C16F84593C24244F'
      this.tagStub = this.sinon.stub(util, 'randomTag').returns(1)
      this.prepareStub = this.sinon.stub(this.plugin._api, 'preparePaymentChannelCreate').resolves({ txJSON: '{}' })

      this.loadStub = this.sinon.stub(this.plugin._api, 'getPaymentChannel')
        .callsFake(id => {
          assert.equal(id, this.channelId)
          return Promise.resolve(this.channel)
        })

      this.reloadStub = this.sinon.stub(this.plugin, '_reloadIncomingChannelDetails')
        .resolves(null)
    })

    it('should load outgoing channel if exists', async function () {
      this.plugin._store.load('outgoing_channel')
      this.plugin._store.set('outgoing_channel', this.channelId)

      await this.plugin._connect()

      assert.isTrue(this.loadStub.called, 'should have loaded outgoing channel')
      assert.isTrue(this.reloadStub.called, 'should have reloaded incoming channel')
    })

    it('should prepare a payment channel', async function () {
      await this.plugin._connect()

      assert.isTrue(this.tagStub.called, 'should have generated source tag')
      assert.isTrue(this.prepareStub.called, 'should have generated prepare tx')
      assert.isTrue(this.signStub.called, 'should have signed xrp tx')
      assert.isTrue(this.submitStub.called, 'should have submitted tx to ledger')
      assert.isTrue(this.loadStub.called, 'should have loaded outgoing channel')
      assert.isTrue(this.reloadStub.called, 'should have reloaded incoming channel')
    })
  })

  describe('_claimFunds', function () {
    beforeEach(function () {
      this.plugin._incomingClaim = {
        amount: '100',
        signature: 'some signature'
      }

      this.plugin._incomingChannelDetails = this.channel
      this.prepareStub = this.sinon.stub(this.plugin._api, 'preparePaymentChannelClaim')
        .resolves({ txJSON: '{}' })
    })

    it('should return if incomingClaim has no signature', async function () {
      delete this.plugin._incomingClaim.signature

      await this.plugin._claimFunds()

      assert.isFalse(this.prepareStub.called, 'should not have prepared a claim tx with no signature')
    })

    it('should submit tx if incomingClaim is valid', async function () {
      await this.plugin._claimFunds()

      assert.isTrue(this.prepareStub.called, 'tx should be prepared')
      assert.isTrue(this.signStub.called, 'tx should be signed')
      assert.isTrue(this.submitStub.called, 'transaction should be submitted to ledger')
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
      this.plugin._outgoingChannel = 'my_channel_id'
      this.plugin._outgoingClaim = { amount: '0' }
      this._outgoingClaim = {
        amount: '100',
        signature: '61626364656667'
      }
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

      this.naclStub = this.sinon.stub(nacl.sign.detached, 'verify').returns(true)
    })

    it('throws an error if new claim is less than old claim', async function () {
      this.plugin._incomingClaim.amount = '100'
      await assert.isRejected(
        this.plugin._handleMoney(null, { requestId: 1, data: this.claimData() }),
        /new claim is less than old claim. new=100 old=100/)
    })

    it('throws an error if the signature is not valid', async function () {
      this.naclStub.throws()
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
