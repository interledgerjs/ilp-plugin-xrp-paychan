'use strict'

const chai = require('chai')
const chaiAsPromised = require('chai-as-promised')
chai.use(chaiAsPromised)
const assert = chai.assert
const expect = chai.expect

const ilpPacket = require('ilp-packet')
const crypto = require('crypto')
const BigNumber = require('bignumber.js')
const PluginRipple = require('../../index.js')
const RippleAPI = require('ripple-lib').RippleAPI
const Store = require('ilp-store-memory')
const {payTo, ledgerAccept} = require('./utils')
const { sleep, dropsToXrp } = require('../../src/lib/constants')

const SERVER_URL = 'ws://127.0.0.1:6006'
const COMMON_OPTS = {
  maxBalance: 'Infinity',
  settleDelay: 2 * 60 * 60, // 2 hours
  token: 'shared_secret',
  rippledServer: SERVER_URL,
  maxUnsecured: '5000',
  channelAmount: 100000,
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

    const sharedSecret = 'secret'
    const serverHost = 'localhost'
    const serverPort = 3000

    this.plugin = new PluginRipple(Object.assign({}, COMMON_OPTS, {
      address: this.newWallet.address,
      secret: this.newWallet.secret,
      peerAddress: this.peer.address,
      server: `btp+ws://:${sharedSecret}@${serverHost}:${serverPort}`,
      _store: new Store()
    }))
    this.peerPlugin = new PluginRipple(Object.assign({}, COMMON_OPTS, {
      address: this.peer.address,
      secret: this.peer.secret,
      peerAddress: this.newWallet.address,
      _store: new Store(),
      listener: {
        port: serverPort,
        secret: sharedSecret
      },
      prefix: 'g.xrp.mypaychan.',
      info: {
        prefix: 'g.xrp.mypaychan.',
        currencyScale: 6,
        currencyCode: 'XRP',
        connector: []
      }
    }))

    // this.plugin.registerDataHandler(() => {})
    // this.peerPlugin.registerDataHandler(() => {})

    // automatically accept the ledger when api.submit() is called
    const autoAcceptLedger = (api) => {
      const originalSubmit = api.submit
      api.submit = async (...args) => {
        return originalSubmit.call(api, ...args).then((result) => {
          setTimeout(acceptLedger.bind(null, this.api), 20)
          return result
        })
      }
    }
    autoAcceptLedger(this.plugin._api)
    autoAcceptLedger(this.peerPlugin._api)
  })
  afterEach(teardown)

  describe('connect()', function () {
    it('is eventually fulfilled', async function () {
      const connectPromise = Promise.all([this.peerPlugin.connect(),
        this.plugin.connect()])
      return expect(connectPromise).to.be.eventually.fulfilled
    })

    it('creates an outgoing paychan', async function () {
      await connectPlugins(this.peerPlugin, this.plugin)

      const paychanid = this.plugin._outgoingChannel
      const chan = await this.api.getPaymentChannel(paychanid)

      assert.strictEqual(chan.account, this.newWallet.address)
      assert.strictEqual(chan.amount, dropsToXrp(COMMON_OPTS.channelAmount))
      assert.strictEqual(chan.balance, '0')
      assert.strictEqual(chan.destination, this.peer.address)
      assert.strictEqual(chan.settleDelay, COMMON_OPTS.settleDelay)
      const expectedPubKey = 'ED' + Buffer.from(this.plugin._keyPair.publicKey)
        .toString('hex').toUpperCase()
      assert.strictEqual(chan.publicKey, expectedPubKey)
    })

    it('has an incoming paychan', async function () {
      await connectPlugins(this.peerPlugin, this.plugin)

      const paychanid = this.plugin._incomingChannel
      const chan = await this.api.getPaymentChannel(paychanid)

      assert.strictEqual(chan.account, this.peer.address)
      assert.strictEqual(chan.amount, dropsToXrp(COMMON_OPTS.channelAmount))
      assert.strictEqual(chan.balance, '0')
      assert.strictEqual(chan.destination, this.newWallet.address)
      assert.strictEqual(chan.settleDelay, COMMON_OPTS.settleDelay)

      const expectedPubKey = 'ED' + Buffer.from(this.peerPlugin._keyPair.publicKey)
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

      this.fulfillment = Buffer.from('E4840A1A3C50A1635CC53F637721114BEBAF3EAB02FE1AC7C97A6F100311A3ED', 'hex')
      this.transfer = {
        amount: '10',
        expiresAt: new Date(Date.now() + 10000),
        executionCondition: crypto.createHash('sha256').update(this.fulfillment).digest(),
        destination: 'peer.example',
        data: Buffer.from('hello world')
      }

      // this.transfer = {
      //   id: uuid(),
      //   ledger: this.plugin.getInfo().prefix,
      //   from: this.plugin.getAccount(),
      //   to: this.plugin.getPeerAccount(),
      //   expiresAt: new Date(Date.now() + 10000).toISOString(),
      //   amount: '5',
      //   custom: {
      //     field: 'some stuff'
      //   },
      // executionCondition: base64url(crypto
      //   .createHash('sha256')
      //   .update(this.fulfillment)
      //   .digest())
      // }

      // this.autoFulfill = new Promise((resolve, reject) => {
      //   this.peerPlugin.on('incoming_prepare', async (transfer) => {
      //     await this.peerPlugin.fulfillCondition(
      //       transfer.id,
      //       base64url(this.fulfillment)
      //     )
      //     resolve()
      //   })
      // })
      // 
      this.peerPlugin.registerDataHandler((ilp) => {
        return ilpPacket.serializeIlpFulfill({
          fulfillment: this.fulfillment,
          data: Buffer.from('hello world again')
        })
      })
    })

    it('submits a claim on disconnect', async function () {
      await this.plugin.sendMoney(this.transfer.amount)

      // disconnect() makes the plugin submit a claim
      await this.peerPlugin.disconnect()

      // assert that the balance on-ledger was adjusted
      const paychanid = this.plugin._outgoingChannel
      const chan = await this.api.getPaymentChannel(paychanid)
      assert.strictEqual(chan.balance, dropsToXrp(this.transfer.amount))
    })

    it('funds a paychan', async function () {
      const expectedAmount = new BigNumber(dropsToXrp(COMMON_OPTS.channelAmount)).times(2)
      const ledgerClose = new Promise((resolve, reject) => {
        this.api.connection.on('ledgerClosed', async (ev) => {
          const chan = await this.api.getPaymentChannel(this.plugin._outgoingChannel)
          assert.equal(chan.amount, expectedAmount, 'Channel does not have expected amount')
          resolve()
        })
      })

      // assert that the channel has the initial amount
      const chan = await this.api.getPaymentChannel(this.plugin._outgoingChannel)
      assert.equal(chan.amount, dropsToXrp(COMMON_OPTS.channelAmount))

      // send a transfer that triggers a funding tx
      const expectedFundingThreshold = parseInt(COMMON_OPTS.channelAmount) *
        parseFloat(COMMON_OPTS.fundThreshold) + 1
      await this.plugin.sendMoney(expectedFundingThreshold)
      return ledgerClose
    })
  })
})
