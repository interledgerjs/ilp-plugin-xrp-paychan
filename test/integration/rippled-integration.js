'use strict' /* eslint-env mocha */

const chai = require('chai')
const chaiAsPromised = require('chai-as-promised')
chai.use(chaiAsPromised)
const assert = chai.assert
const expect = chai.expect

const chalk = require('chalk')
const btpPacket = require('btp-packet')
const crypto = require('crypto')
const BigNumber = require('bignumber.js')
const PluginRipple = require('../../index.js')
const RippleAPI = require('ripple-lib').RippleAPI
const Store = require('ilp-store-memory')
const { payTo, ledgerAccept, autoAcceptLedger, spawnParallel } = require('./utils')
const { sleep, dropsToXrp } = require('../../src/lib/constants')
const { util } = require('ilp-plugin-xrp-paychan-shared')
const nacl = require('tweetnacl')

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

async function exchangePaychanIds (plugin) {
  await plugin.connect()
  // wait so that the plugins exchange channel ids.
  await sleep(500) // TODO: remove sleep once channel id exchange is refactored
  await plugin._reloadIncomingChannelDetails()
}

async function teardown () {
  if (this.plugin && this.plugin.isConnected()) await this.plugin.disconnect()
  if (this.peerPluginProc) this.peerPluginProc.kill('SIGINT')
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
    this.timeout(10000)
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
    autoAcceptLedger(this.plugin._api)

    const peerOpts = Object.assign({}, COMMON_OPTS, {
      address: this.peer.address,
      secret: this.peer.secret,
      peerAddress: this.newWallet.address,
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
    })
    await new Promise((resolve, reject) => {
      this.peerPluginProc = spawnParallel('node', ['test/integration/run-peer-plugin'], {
        env: {
          opts: JSON.stringify(peerOpts),
          DEBUG: 'ilp*'
        }
      }, function (line, enc, callback) { // formatter
        this.push('' + chalk.dim('btp-server ') + line.toString('utf-8') + '\n')
        const strLine = line.toString('utf-8')
        if (strLine.includes('listening for BTP connections')) resolve()
        if (strLine.includes('Error connecting peer plugin')) reject(new Error(strLine))
        callback()
      })
    })

    const keyPairSeed = util.hmac(this.peer.secret,
      'ilp-plugin-xrp-paychan-channel-keys' + this.newWallet.address)
    this.peerKeyPair = nacl.sign.keyPair.fromSeed(keyPairSeed)
  })
  afterEach(teardown)

  describe('connect()', function () {
    it('is eventually fulfilled', async function () {
      await this.plugin.connect()
      const connectPromise = Promise.all([this.plugin.connect()])
      return expect(connectPromise).to.be.eventually.fulfilled
    })

    it('creates an outgoing paychan', async function () {
      await exchangePaychanIds(this.plugin)

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
      await exchangePaychanIds(this.plugin)

      const paychanid = this.plugin._incomingChannel
      const chan = await this.api.getPaymentChannel(paychanid)

      assert.strictEqual(chan.account, this.peer.address)
      assert.strictEqual(chan.amount, dropsToXrp(COMMON_OPTS.channelAmount))
      assert.strictEqual(chan.balance, '0')
      assert.strictEqual(chan.destination, this.newWallet.address)
      assert.strictEqual(chan.settleDelay, COMMON_OPTS.settleDelay)

      const expectedPubKey = 'ED' + Buffer.from(this.peerKeyPair.publicKey)
        .toString('hex').toUpperCase()

      assert.strictEqual(chan.publicKey, expectedPubKey)
    })
  })

  describe('channel claims and funding', function () {
    beforeEach(async function () {
      await exchangePaychanIds(this.plugin)
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

      this.claimAmount = 10
      const encodedClaim = util.encodeClaim(this.claimAmount, this.plugin._incomingChannel)
      const sig = nacl.sign.detached(encodedClaim, this.peerKeyPair.secretKey)
      this.claimSignature = Buffer.from(sig).toString('hex').toUpperCase()
      this.claimData = () => ({
        amount: this.claimAmount,
        protocolData: [{
          protocolName: 'claim',
          contentType: btpPacket.MIME_APPLICATION_JSON,
          data: JSON.stringify({
            amount: this.claimAmount,
            signature: this.claimSignature
          })
        }]
      })
    })

    it('submits a claim on disconnect', async function () {
      await this.plugin._handleMoney(null, { requestId: 1, data: this.claimData() })
      await this.plugin._claimFunds()

      // assert that the balance on-ledger was adjusted
      const paychanid = this.plugin._incomingChannel
      const chan = await this.api.getPaymentChannel(paychanid)
      assert.strictEqual(chan.balance, dropsToXrp(this.claimAmount))
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
