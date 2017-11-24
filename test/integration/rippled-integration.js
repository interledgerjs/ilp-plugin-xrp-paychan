'use strict'

const chai = require('chai')
const chaiAsPromised = require('chai-as-promised')
chai.use(chaiAsPromised)
const assert = chai.assert
const expect = chai.expect

const crypto = require('crypto')
const uuid = require('uuid')
const base64url = require('base64url')
const BigNumber = require('bignumber.js')
const PluginRipple = require('../../index.js')
const RippleAPI = require('ripple-lib').RippleAPI
const Store = require('ilp-plugin-payment-channel-framework/test/helpers/objStore')
const {payTo, ledgerAccept} = require('./utils')
const { sleep, dropsToXrp } = require('../../src/lib/constants')

const SERVER_URL = 'ws://127.0.0.1:6006'
const COMMON_OPTS = {
  maxBalance: 'Infinity',
  settleDelay: 2 * 60 * 60, // 2 hours
  token: 'shared_secret',
  rippledServer: SERVER_URL,
  maxUnsecured: '5000',
  maxAmount: '100000',
  fundThreshold: '0.9'
}

function acceptLedger (api) {
  return api.connection.request({command: 'ledger_accept'})
}

function setup (server = 'wss://s1.ripple.com') {
  this.api = new RippleAPI({server})
  return this.api.connect().then(() => {
  }, error => {
    console.log('ERROR connecting to rippled:', error)
    throw error
  })
}

function setupAccounts (testcase) {
  const api = testcase.api

  return payTo(api, 'rMH4UxPrbuMa1spCBR98hLLyNJp4d8p4tM')
    .then(() => payTo(api, testcase.newWallet.address))
    .then(() => payTo(api, testcase.peer.address))
}

async function connectPlugins (...plugins) {
  const promise = Promise.all(plugins.map((p) => p.connect()))
  await sleep(100) // wait until the plugins have exchanged their channel IDs
  return promise
}

async function teardown () {
  const disconnectPlugin = async function (plugin) {
    if (plugin && plugin.isConnected()) {
      return plugin.disconnect()
    }
  }
  await disconnectPlugin(this.plugin)
  await disconnectPlugin(this.peerPlugin)
  return this.api.disconnect()
}

function suiteSetup () {
  this.transactions = []

  return setup.bind(this)(SERVER_URL)
    .then(() => ledgerAccept(this.api))
    .then(() => { this.newWallet = this.api.generateAddress() })
    .then(() => { this.peer = this.api.generateAddress() })
    // two times to give time to server to send `ledgerClosed` event
    // so getLedgerVersion will return right value
    .then(() => ledgerAccept(this.api))
    .then(() => this.api.getLedgerVersion())
    .then(ledgerVersion => {
      this.startLedgerVersion = ledgerVersion
    })
    .then(() => setupAccounts(this))
    .then(() => teardown.bind(this)())
}

describe('plugin integration', function () {
  before(suiteSetup)
  beforeEach(async function () {
    await setup.call(this, SERVER_URL)

    const sharedSecret = 'shh its a secret'
    const serverHost = 'localhost'
    const serverPort = 3000

    this.plugin = new PluginRipple(Object.assign({}, COMMON_OPTS, {
      // This plugin's ripple address and secret.
      // Get testnet credentials at https://ripple.com/build/xrp-test-net/
      address: this.newWallet.address,
      secret: this.newWallet.secret,

      // The peer you want to start a payment channel with
      peerAddress: this.peer.address,

      // Our peer acts as BTP server. This is the address he is listening on
      server: `btp+ws://:${sharedSecret}@${serverHost}:${serverPort}`,

      // Other options. For details see:
      // https://github.com/interledger/rfcs/blob/master/0004-ledger-plugin-interface/0004-ledger-plugin-interface.md#class-pluginoptions
      _store: new Store()
    }))
    this.peerPlugin = new PluginRipple(Object.assign({}, COMMON_OPTS, {
      // This plugin's ripple address and secret.
      // Get testnet credentials at https://ripple.com/build/xrp-test-net/
      address: this.peer.address,
      secret: this.peer.secret,

      // The peer you want to start a payment channel with
      peerAddress: this.newWallet.address,

      // Other options. For details see:
      // https://github.com/interledger/rfcs/blob/master/0004-ledger-plugin-interface/0004-ledger-plugin-interface.md#class-pluginoptions
      _store: new Store(),
      listener: {
        port: serverPort
      },
      incomingSecret: sharedSecret,
      prefix: 'g.xrp.mypaychan.',
      info: {
        prefix: 'g.xrp.mypaychan.',
        currencyScale: 6,
        currencyCode: 'XRP',
        connector: []
      }
    }))

    this.pluginState = this.plugin._paychanContext.state

    // automatically accept the ledger when api.submit() is called
    const autoAcceptLedger = (api) => {
      const originalSubmit = api.submit
      api.submit = async (...args) => {
        const result = originalSubmit.call(api, ...args)
        setTimeout(acceptLedger.bind(null, this.api), 20)
        return result
      }
    }

    autoAcceptLedger(this.plugin._paychanContext.state.api)
    autoAcceptLedger(this.peerPlugin._paychanContext.state.api)
  })
  afterEach(teardown)

  describe('connect()', function () {
    it('is eventually fulfilled', async function () {
      const connectPromise = Promise.all([this.peerPlugin.connect(),
        this.plugin.connect()])
      await sleep(10)
      return expect(connectPromise).to.be.eventually.fulfilled
    })

    it('creates an outgoing paychan', async function () {
      await connectPlugins(this.peerPlugin, this.plugin)

      const paychanid = await this.pluginState.outgoingChannel.getMax()
      const chan = await this.api.getPaymentChannel(paychanid.data)

      assert.strictEqual(chan.account, this.newWallet.address)
      assert.strictEqual(chan.amount, dropsToXrp(COMMON_OPTS.maxAmount))
      assert.strictEqual(chan.balance, '0')
      assert.strictEqual(chan.destination, this.peer.address)
      assert.strictEqual(chan.settleDelay, COMMON_OPTS.settleDelay)
      const expectedPubKey = 'ED' + Buffer.from(this.pluginState.keyPair.publicKey)
        .toString('hex').toUpperCase()
      assert.strictEqual(chan.publicKey, expectedPubKey)
    })

    it('has an incoming paychan', async function () {
      await connectPlugins(this.peerPlugin, this.plugin)

      const paychanid = this.pluginState.incomingPaymentChannelId
      const chan = await this.api.getPaymentChannel(paychanid)

      assert.strictEqual(chan.account, this.peer.address)
      assert.strictEqual(chan.amount, dropsToXrp(COMMON_OPTS.maxAmount))
      assert.strictEqual(chan.balance, '0')
      assert.strictEqual(chan.destination, this.newWallet.address)
      assert.strictEqual(chan.settleDelay, COMMON_OPTS.settleDelay)

      const pubKeyUIntA = this.peerPlugin._paychanContext.state.keyPair.publicKey
      const expectedPubKey = 'ED' + Buffer.from(pubKeyUIntA)
        .toString('hex').toUpperCase()
      assert.strictEqual(chan.publicKey, expectedPubKey)
    })
  })

  describe('channel claims and funding', function () {
    beforeEach(async function () {
      await connectPlugins(this.peerPlugin, this.plugin)
      await this.api.connection.request({
        command: 'subscribe',
        accounts: [ this.newWallet.address, this.peer.address ]
      })

      this.fulfillment = crypto.randomBytes(32)
      this.transfer = {
        id: uuid(),
        ledger: this.plugin.getInfo().prefix,
        from: this.plugin.getAccount(),
        to: this.plugin.getPeerAccount(),
        expiresAt: new Date(Date.now() + 10000).toISOString(),
        amount: '5',
        custom: {
          field: 'some stuff'
        },
        executionCondition: base64url(crypto
          .createHash('sha256')
          .update(this.fulfillment)
          .digest())
      }

      this.autoFulfill = new Promise((resolve, reject) => {
        this.peerPlugin.on('incoming_prepare', async (transfer) => {
          await this.peerPlugin.fulfillCondition(
            transfer.id,
            base64url(this.fulfillment)
          )
          resolve()
        })
      })
    })

    it('submits a claim on disconnect', async function () {
      await this.plugin.sendTransfer(this.transfer)
      await this.autoFulfill
      const peerBalance = await this.peerPlugin.getBalance()

      // disconnect() makes the plugin submit a claim
      await this.peerPlugin.disconnect()

      // assert that the balance on-ledger was adjusted
      const paychanid = await this.pluginState.outgoingChannel.getMax()
      const chan = await this.api.getPaymentChannel(paychanid.data)
      assert.strictEqual(chan.balance, dropsToXrp(this.transfer.amount))

      // assert that the plugins' stored balance matches the on-ledger balance
      assert.strictEqual(peerBalance, this.transfer.amount)
      assert.equal(await this.plugin.getBalance(), -1 * parseInt(this.transfer.amount))
    })

    it('funds a paychan', async function () {
      const chanId = this.pluginState.outgoingPaymentChannelId
      this.transfer.amount = COMMON_OPTS.maxUnsecured
      const expectedFundingThreshold = parseInt(COMMON_OPTS.maxAmount) *
        parseFloat(COMMON_OPTS.fundThreshold)

      // send transfers until the funding threshold is exceeded
      while (parseFloat(await this.peerPlugin.getBalance()) <= expectedFundingThreshold) {
        // assert that the plugin has not yet issued a funding tx
        const chan = await this.api.getPaymentChannel(chanId)
        assert(chan.amount, dropsToXrp(COMMON_OPTS.maxAmount))

        this.transfer.id = uuid()
        await this.plugin.sendTransfer(this.transfer)
        await new Promise((resolve, reject) => {
          this.plugin.on('outgoing_fulfill', () => resolve())
        })
      }

      const expectedAmount = new BigNumber(dropsToXrp(COMMON_OPTS.maxAmount))
        .mul(2).toString()
      await new Promise((resolve, reject) => {
        this.api.connection.on('ledgerClosed', async (ev) => {
          const chan = await this.api.getPaymentChannel(chanId)
          if (chan.amount === expectedAmount) resolve()
        })
      })
    })
  })
})
