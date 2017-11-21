'use strict'

const chai = require('chai')
const chaiAsPromised = require('chai-as-promised')
chai.use(chaiAsPromised)
const sinon = require('sinon')
const sinonChai = require('sinon-chai')
chai.use(sinonChai)

const assert = chai.assert
const expect = chai.expect

const MockSocket = require('ilp-plugin-payment-channel-framework/test/helpers/mockSocket')
const Store = require('ilp-plugin-payment-channel-framework/test/helpers/objStore')

const apiHelper = require('./helper/apiHelper')
const btpPacket = require('btp-packet')
const proxyquire = require('proxyquire')
const {
  STATE_CREATING_CHANNEL,
  STATE_CHANNEL,
  POLLING_INTERVAL,
  dropsToXrp,
  sleep
} = require('../src/lib/constants')

describe('channelSpec', function () {
  beforeEach(function () {
    // Plugin Options
    this.opts = {
      maxBalance: '1000000000',
      server: 'btp+wss://btp-server.example',
      prefix: 'g.eur.mytrustline.',
      info: {
        prefix: 'g.eur.mytrustline.',
        currencyScale: 9,
        currencyCode: 'XRP',
        connector: []
      },
      settleDelay: 10,
      token: 'shared_secret',
      rippledServer: 'wss://s.altnet.rippletest.net:51233',
      address: 'rQBHyjckUFGZK1nPDKzTU8Zyvd2niqHcpo',
      secret: 'shDssKGbxxpJacxpQzfacKcnutYGU',
      peerAddress: 'rPZUg1NH7gAfkpRpKbcwyn8ET7EPqhTFiv',
      channelSecret: 'shh its a secret',
      maxUnsecured: '5000',
      maxAmount: '100000',
      rpcUri: 'btp+wss://peer.example',
      _store: new Store()
    }
    this.claim = {
      amount: 5,
      signature: '1bbcfe0cf035a07a95f90d750daff948fb92e367ba237955d6799d76db6e0a06016da211dce212f4bbc5a88e95d724b316b1f800ed55f648585eb48a16371c09'
    }
    this.exceedingClaim = {
      amount: 5000000,
      signature: '8b9b8af4ec65aaf53760d23cc2b70aee3e4f79647f10034524106b868b6a6198a80839bd7f83b086799665ae63537ef0f4bda0daad61d9f9942e1dd3c686ad00'
    }

    const ApiStub = apiHelper.makeApi(this.opts)
    const PluginRipple = proxyquire('../index', {
      'ripple-lib': {
        'RippleAPI': ApiStub
      }
    })

    this.plugin = new PluginRipple(this.opts)
    this.pluginState = this.plugin._paychanContext.state
    this.mockSocket = new MockSocket()
    this.mockSocket.reply(btpPacket.TYPE_MESSAGE, ({requestId}) => {
      return btpPacket.serializeResponse(requestId, []) // reply to auth message
    })
    this.plugin.addSocket(this.mockSocket, {username: '', token: ''})
    this.incomingPaymentChannelId = 1234567890

    this.payChanIdRequestNull = [{
      protocolName: 'ripple_channel_id',
      contentType: btpPacket.MIME_APPLICATION_JSON,
      data: Buffer.from(JSON.stringify(null))
    }]
    this.payChanIdRequest = [{
      protocolName: 'ripple_channel_id',
      contentType: btpPacket.MIME_APPLICATION_JSON,
      data: Buffer.from('[]')
    }]
    this.payChanIdResponse = [{
      protocolName: 'ripple_channel_id',
      contentType: btpPacket.MIME_APPLICATION_JSON,
      data: Buffer.from(`"${this.incomingPaymentChannelId}"`)
    }]
  })

  afterEach(async function () {
    assert(await this.mockSocket.isDone(), 'request handlers must have been called')
  })

  describe('connect', function () {
    it('creates a payment channel', async function () {
      this.mockSocket.reply(btpPacket.TYPE_MESSAGE, ({requestId}) => {
        return btpPacket.serializeResponse(requestId, this.payChanIdResponse)
      })

      const connectSpy = sinon.spy(this.pluginState.api, 'connect')
      const prepareSpy = sinon.spy(this.pluginState.api, 'preparePaymentChannelCreate')
      const signSpy = sinon.spy(this.pluginState.api, 'sign')
      const submitSpy = sinon.spy(this.pluginState.api, 'submit')

      await this.plugin.connect()

      expect(connectSpy).to.have.been.calledOnce
      expect(prepareSpy).to.have.been.calledAfter(connectSpy).and
        .calledWith(this.opts.address)
      expect(signSpy).to.have.been.calledAfter(prepareSpy).and
        .calledWith('"some JSON string"')
      expect(submitSpy).to.have.been.calledAfter(signSpy).and
        .calledWith('1234567890ABCDEF')

      const [ , payChanCreate ] = prepareSpy.firstCall.args
      delete payChanCreate.sourceTag
      const expectedPubKey = 'ED' + Buffer.from(this.pluginState.keyPair.publicKey)
        .toString('hex').toUpperCase()
      assert.deepEqual(payChanCreate, {
        amount: dropsToXrp(this.opts.maxAmount),
        destination: this.opts.peerAddress,
        settleDelay: this.opts.settleDelay,
        publicKey: expectedPubKey
      })
    })

    it('uses existing payment channel', async function () {
      this.mockSocket.reply(btpPacket.TYPE_MESSAGE, ({requestId}) => {
        return btpPacket.serializeResponse(requestId, this.payChanIdResponse)
      })

      const outgoingChannel = this.plugin._paychanContext.backend
        .getMaxValueTracker('outgoing_channel')
      await outgoingChannel.setIfMax({
        value: STATE_CHANNEL,
        data: '1234567890ABCDEF'
      })

      const submitSpy = sinon.spy(this.pluginState.api, 'submit')
      await this.plugin.connect()
      expect(submitSpy).to.have.not.been.called
      expect(this.pluginState.outgoingPaymentChannelId)
        .to.be.equal('1234567890ABCDEF')
    })

    it('waits for another instance to create a channel', async function () {
      this.mockSocket.reply(btpPacket.TYPE_MESSAGE, ({requestId}) => {
        return btpPacket.serializeResponse(requestId, this.payChanIdResponse)
      })

      const realSetTimeout = setTimeout
      const sleep = (time) => new Promise((resolve) => realSetTimeout(resolve, time))
      const clock = sinon.useFakeTimers({toFake: ['setTimeout']})

      const outgoingChannel = this.pluginState.outgoingChannel
      await outgoingChannel.setIfMax({
        value: STATE_CREATING_CHANNEL,
        data: 'ade66de4-9cbf-4f0d-8084-42e10247a4fb'
      })

      const submitSpy = sinon.spy(this.pluginState.api, 'submit')
      this.plugin.connect()

      await sleep(10) // wait for the plugin to start polling
      await outgoingChannel.setIfMax({
        value: STATE_CHANNEL,
        data: '1234567890ABCDEF'
      })
      clock.tick(POLLING_INTERVAL + 1000)
      await sleep(10) // wait for the plugin to retrieve the channelId

      expect(submitSpy).to.have.not.been.called
      expect(this.pluginState.outgoingPaymentChannelId)
        .to.be.equal('1234567890ABCDEF')
      clock.restore()
    })

    it('requests incoming payment channel id on connect()', async function () {
      this.mockSocket.reply(btpPacket.TYPE_MESSAGE, ({requestId, data}) => {
        assert.nestedProperty(data, 'protocolData')
        assert.deepEqual(data.protocolData, this.payChanIdRequest)
        return btpPacket.serializeResponse(requestId, this.payChanIdResponse)
      })
      await this.plugin.connect()

      assert.equal(this.pluginState.incomingPaymentChannelId,
        this.incomingPaymentChannelId)
    })

    it('requests incoming payment channel id on ripple_channel_id request', async function () {
      // The first ripple_channel_id request is anwsered with null.
      // Only on the second ripple_channel_id request the mockSocket returns 
      // the channel id.
      this.mockSocket.reply(btpPacket.TYPE_MESSAGE, ({requestId, data}) => {
        assert.nestedProperty(data, 'protocolData')
        assert.deepEqual(data.protocolData, this.payChanIdRequest)
        return btpPacket.serializeResponse(requestId, this.payChanIdRequestNull)
      }).reply(btpPacket.TYPE_RESPONSE)
        .reply(btpPacket.TYPE_MESSAGE, ({requestId, data}) => {
          assert.nestedProperty(data, 'protocolData')
          assert.deepEqual(data.protocolData, this.payChanIdRequest)
          return btpPacket.serializeResponse(requestId, this.payChanIdResponse)
        })
      await this.plugin.connect()

      // the plugin should not yet have an incoming pay chan id after connect()
      assert.equal(this.pluginState.incomingPaymentChannelId, null)

      // a ripple_channel_id request should trigger the plugin to try again
      // to get the incoming payment channel id
      const btpMessage = btpPacket.serializeMessage(1234, this.payChanIdRequest)
      this.mockSocket.emit('message', btpMessage)
      await sleep(10)
      assert.equal(this.pluginState.incomingPaymentChannelId,
        this.incomingPaymentChannelId)
    })

    it('sends outgoing payment channel id', async function () {
      this.mockSocket
        .reply(btpPacket.TYPE_MESSAGE, ({requestId}) => {
          return btpPacket.serializeResponse(requestId, this.payChanIdResponse)
        })
        .reply(btpPacket.TYPE_RESPONSE, ({requestId, data}) => {
          assert.equal(requestId, 1234)
          assert.lengthOf(data.protocolData, 1)
          assert.equal(data.protocolData[0].protocolName, 'ripple_channel_id')
          assert.equal(data.protocolData[0].contentType, btpPacket.MIME_APPLICATION_JSON)
          const actualChanId = JSON.parse(data.protocolData[0].data.toString('utf8'))
          assert.equal(actualChanId, this.pluginState.outgoingPaymentChannelId)
        })

      await this.plugin.connect()

      const btpMessage = btpPacket.serializeMessage(1234, this.payChanIdRequest)
      this.mockSocket.emit('message', btpMessage)
    })
  })

  describe('incoming claim', function () {
    beforeEach(async function () {
      this.mockSocket.reply(btpPacket.TYPE_MESSAGE, ({requestId}) => {
        return btpPacket.serializeResponse(requestId, this.payChanIdResponse)
      })
      await this.plugin.connect()
    })

    it('handles an incoming claim', async function () {
      await this.plugin._paychan.handleIncomingClaim({state: this.pluginState}, this.claim)

      const max = await this.pluginState.incomingClaim.getMax()
      assert.equal(max.value, this.claim.amount)
      assert.equal(max.data, this.claim.signature)
    })

    it('rejects an incoming claim with invalid signature', async function () {
      this.claim.signature = 'INVALID'
      try {
        await this.plugin._paychan.handleIncomingClaim({state: this.pluginState}, this.claim)
      } catch (err) {
        assert.equal(err.message, 'got invalid claim signature INVALID for amount 5 drops')
        return
      }
      assert(false, 'should reject claim')
    })

    it('rejects an incoming claim that exceeds the channel amount', async function () {
      try {
        await this.plugin._paychan.handleIncomingClaim({state: this.pluginState}, this.exceedingClaim)
      } catch (err) {
        assert.equal(err.message, 'got claim for amount higher than channel balance. amount: 5000000, incoming channel balance: 100000')
        return
      }
      assert(false, 'should reject claim')
    })
  })

  describe('outgoing claim', function () {
    beforeEach(async function () {
      this.mockSocket.reply(btpPacket.TYPE_MESSAGE, ({requestId}) => {
        return btpPacket.serializeResponse(requestId, this.payChanIdResponse)
      })
      await this.plugin.connect()
    })

    it('creates a claim', async function () {
      const expectClaim = {
        amount: this.pluginState.maxAmount,
        signature: 'fa460348af737eb6071b5793cb1534c3668508b993a34e9069847e39b07e064e62b957e6ed7de3b14bf629cd66662ec37049bc123a9561eb39589496ba7d3001'
      }
      const claim = await this.plugin._paychan.createOutgoingClaim({
        state: this.pluginState
      }, this.pluginState.maxAmount)
      assert.deepEqual(claim, expectClaim)
    })

    it('adds funding if channel runs dry', async function () {
      const prepareSpy = sinon.spy(this.pluginState.api, 'preparePaymentChannelFund')
      const submitSpy = sinon.spy(this.pluginState.api, 'submit')

      await this.plugin._paychan.createOutgoingClaim({
        state: this.pluginState
      }, this.pluginState.maxAmount) // exceeds the configured funding threshold

      expect(prepareSpy).to.have.been.calledWith(this.opts.address, {
        amount: dropsToXrp(this.opts.maxAmount),
        channel: String(this.pluginState.outgoingPaymentChannelId)
      })
      expect(submitSpy).to.have.been.calledWith('1234567890ABCDEF')
      setImmediate(() => { // wait for the callback to update maxAmount
        expect(this.pluginState.maxAmount).to.be.equal('200000000')
      })
    })
  })

  describe('submits claims', function () {
    beforeEach(async function () {
      this.mockSocket.reply(btpPacket.TYPE_MESSAGE, ({requestId}) => {
        return btpPacket.serializeResponse(requestId, this.payChanIdResponse)
      })
      await this.plugin.connect()
    })

    it('submits claim on disconnect', async function () {
      const prepareSpy = sinon.spy(this.pluginState.api, 'preparePaymentChannelClaim')
      const submitSpy = sinon.spy(this.pluginState.api, 'submit')

      await this.plugin._paychan.handleIncomingClaim({state: this.pluginState}, this.claim)
      await this.plugin.disconnect()

      expect(prepareSpy).to.be.calledWith(this.opts.address, {
        balance: dropsToXrp(this.claim.amount),
        channel: String(this.incomingPaymentChannelId),
        signature: this.claim.signature.toUpperCase(),
        publicKey: 'ED' + apiHelper.PEER_PUBLIC_KEY
      })
      expect(submitSpy).to.be.calledAfter(prepareSpy)
        .and.calledWith('1234567890ABCDEF')
    })
  })
})
