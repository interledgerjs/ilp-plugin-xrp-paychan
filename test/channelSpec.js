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
const apiHelper = require('./helper/apiHelper')
const { protocolDataToIlpAndCustom } =
  require('ilp-plugin-payment-channel-framework/src/util/protocolDataConverter')
const btpPacket = require('btp-packet')
const BigNumber = require('bignumber.js')
const proxyquire = require('proxyquire')

const dropsToXrp = (drops) => new BigNumber(drops).div(1000000).toString()

describe('channelSpec', function () {
  beforeEach(function () {
    // Plugin Options
    let store = {}
    this.opts = {
      maxBalance: '1000000000',
      prefix: 'g.eur.mytrustline.',
      settleDelay: 10,
      token: 'shared_secret',
      server: 'wss://s.altnet.rippletest.net:51233',
      address: 'rQBHyjckUFGZK1nPDKzTU8Zyvd2niqHcpo',
      secret: 'shDssKGbxxpJacxpQzfacKcnutYGU',
      peerAddress: 'rPZUg1NH7gAfkpRpKbcwyn8ET7EPqhTFiv',
      channelSecret: 'shh its a secret',
      maxUnsecured: '5000000',
      maxAmount: '100000000',
      rpcUri: 'https://peer.example',
      _store: {
        get: async (k) => store[k],
        put: async (k, v) => { store[k] = v },
        del: async (k) => delete store[k]
      }
    }
    // 
    this.claim = {
      amount: 5,
      signature: '1315c92c5ed0b959b057ce6758eab5152e42ff22c0b73568ffa836ca0415c63a3c401af44e2b73a8730bb39f9ce525083b3cf408754f491f76298520c352940a'
    }
    this.exceedingClaim = {
      amount: 5000000,
      signature: 'f126f94fa55ee23b61c824510e48a93420dbe476d768129f71d188f452ea08d99be56f66feaad83acfe14780f9d5d1fe5dd5d0c933c56ae34029d39561812103'
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
    this.plugin.addSocket(this.mockSocket)
    this.incomingPaymentChannelId = 123456789
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

    it('requests incoming payment channel id', async function () {
      this.mockSocket.reply(btpPacket.TYPE_MESSAGE, ({requestId, data}) => {
        const {custom} = protocolDataToIlpAndCustom(data)
        assert(custom)
        assert(custom.ripple_channel_id)

        return btpPacket.serializeResponse(requestId, this.payChanIdResponse)
      })
      await this.plugin.connect()

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
          const {custom} = protocolDataToIlpAndCustom(data)
          assert.equal(custom.ripple_channel_id,
            this.pluginState.outgoingPaymentChannelId)
        })

      await this.plugin.connect()

      const btpMessage = btpPacket.serializeMessage(1234, [{
        protocolName: 'ripple_channel_id',
        contentType: btpPacket.MIME_APPLICATION_JSON,
        data: Buffer.from('[]')
      }])
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

    it('rejects an incoming claim with invalid signature', function () {
      this.claim.signature = 'INVALID'
      const promise = this.plugin._paychan
        .handleIncomingClaim({state: this.pluginState}, this.claim)
      return expect(promise).to.be.rejectedWith(Error,
        'got invalid claim signature INVALID for amount 5 drops')
    })

    it('rejects an incoming claim that exceeds the channel amount', function () {
      const promise = this.plugin._paychan
        .handleIncomingClaim({state: this.pluginState}, this.exceedingClaim)
      return expect(promise).to.be.rejectedWith(Error,
        'got claim for higher amount 5000000 than channel balance 100')
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
