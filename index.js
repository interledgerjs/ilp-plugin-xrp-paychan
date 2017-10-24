'use strict'

// imports
const { RippleAPI } = require('ripple-lib')
const addressCodec = require('ripple-address-codec')
const { makePaymentChannelPlugin } = require('ilp-plugin-payment-channel-framework')
const uuid = require('uuid')
const nacl = require('tweetnacl')
const crypto = require('crypto')
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest()
const bignum = require('bignum') // required in order to convert to buffer
const BigNumber = require('bignumber.js')
const debug = require('debug')('ilp-plugin-xrp-paychan')

// constants
const DEFAULT_SETTLE_DELAY = 60
const STATE_NO_CHANNEL = '0'
const STATE_CREATING_CHANNEL = '1'
const STATE_CHANNEL = '2'

// utility functions
const sleep = (time) => new Promise((resolve) => setTimeout(resolve, time))
const randomTag = () => bignum.fromBuffer(crypto.randomBytes(4), {
  endian: 'big',
  size: 4
}).toNumber()

const dropsToXrp = (drops) => new BigNumber(drops).div(1000000).toString()

const encodeClaim = (amount, id) => Buffer.concat([
  Buffer.from('CLM\0'),
  Buffer.from(id, 'hex'),
  bignum(amount).toBuffer({
    endian: 'big',
    size: 8
  })
])

const computeChannelId = (src, dest, sequence) => {
  const preimage = Buffer.concat([
    Buffer.from('\0x', 'ascii'),
    Buffer.from(addressCodec.decodeAccountID(src)),
    Buffer.from(addressCodec.decodeAccountID(dest)),
    bignum(sequence).toBuffer({ endian: 'big', size: 4 })
  ])

  return crypto.createHash('sha512')
    .update(preimage)
    .digest()
    .slice(0, 32) // first half sha512
    .toString('hex')
    .toUpperCase()
}

const claimFunds = async (self, amount, signature) => {
  const tx = await self.api.preparePaymentChannelClaim(self.address, {
    balance: dropsToXrp(amount),
    channel: self.incomingPaymentChannelId,
    signature: signature.toUpperCase(),
    publicKey: self.incomingPaymentChannel.publicKey
  })

  const signedTx = self.api.sign(tx.txJSON, self.secret)
  debug('submitting claim transaction ', tx)
  const {resultCode, resultMessage} = await self.api.submit(signedTx.signedTransaction)
  if (resultCode !== 'tesSUCCESS') {
    debug('Error submitting claim: ', resultMessage)
    throw new Error('Could not claim funds: ', resultMessage)
  }

  return new Promise((resolve) => {
    const handleTransaction = function (ev) {
      if (ev.transaction.Account !== self.address) return
      if (ev.transaction.Channel !== self.incomingPaymentChannelId) return
      if (ev.transaction.Balance !== amount) return

      if (ev.engine_result === 'tesSUCCESS') {
        debug('successfully submitted claim', signature, 'for amount', amount)
      } else {
        debug('claiming funds failed ', ev)
      }

      setImmediate(() => self.api.connection
        .removeListener('transaction', handleTransaction))
      resolve()
    }

    self.api.connection.on('transaction', handleTransaction)
  })
}

module.exports = makePaymentChannelPlugin({
  pluginName: 'xrp-paychan',

  constructor: function (ctx, opts) {
    const self = ctx.state
    self.api = new RippleAPI({ rippledServer: opts.server })
    self.address = opts.address
    self.secret = opts.secret
    self.peerAddress = opts.peerAddress
    self.maxUnsecured = opts.maxUnsecured
    self.channelAmount = opts.maxAmount
    self.fundPercent = opts.fundPercent
    self.claimPercent = opts.claimPercent
    self.prefix = opts.prefix // TODO: auto-generate prefix?
    self.peerPublicKey = opts.peerPublicKey // TODO: read the pub key from the result of getPaymentChannel?
    self.authToken = opts.token
    self.settleDelay = opts.settleDelay || DEFAULT_SETTLE_DELAY

    // TODO: figure out best way to create secure keypair
    self.keyPair = nacl.sign.keyPair.fromSeed(sha256(Buffer.from(self.secret)))
    self.outgoingChannel = ctx.backend.getMaxValueTracker('outgoing_channel')
    self.incomingClaim = ctx.backend.getMaxValueTracker('incoming_claim')
    self.incomingClaimSubmitted = ctx.backend.getMaxValueTracker('incoming_claim_submitted')

    ctx.rpc.addMethod('ripple_channel_id', () => {
      return self.outgoingPaymentChannelId || null
    })
  },

  getAuthToken: (ctx) => (ctx.state.authToken),

  connect: async function (ctx) {
    const self = ctx.state
    await self.api.connect()

    await self.api.connection.request({
      command: 'subscribe',
      accounts: [ self.address, self.peerAddress ]
    })

    // establish channel
    const pluginId = uuid()
    const tryToCreate = { value: STATE_CREATING_CHANNEL, data: pluginId }
    const result = await self.outgoingChannel.setIfMax(tryToCreate)
    let channelId

    // if the payment channel has been created already
    if (result.value === STATE_CHANNEL) {
      channelId = result.data
    // if the payment channel has not been created and this process must create it
    } else if (result.value === STATE_NO_CHANNEL) {
      // create the channel
      const txTag = randomTag()
      let tx
      try {
        tx = await self.api.preparePaymentChannelCreate(self.address, {
          amount: dropsToXrp(self.channelAmount),
          destination: self.peerAddress,
          settleDelay: self.settleDelay,
          publicKey: 'ED' + Buffer.from(self.keyPair.publicKey).toString('hex').toUpperCase(),
          sourceTag: txTag
        })
      } catch (e) {
        debug('Error preparing payment channel.', e)
        throw e
      }

      const signedTx = self.api.sign(tx.txJSON, self.secret)
      const {resultCode, resultMessage} = await self.api.submit(signedTx.signedTransaction)
      if (resultCode !== 'tesSUCCESS') {
        debug('Error creating the payment channel: ', resultMessage)
      }

      await new Promise((resolve) => {
        function handleTransaction (ev) {
          if (ev.transaction.SourceTag !== txTag) return
          if (ev.transaction.Account !== self.address) return

          channelId = computeChannelId(
            ev.transaction.Account,
            ev.transaction.Destination,
            ev.transaction.Sequence)

          setImmediate(() => self.api.connection
            .removeListener('transaction', handleTransaction))
          resolve()
        }

        self.api.connection.on('transaction', handleTransaction)
      })

      // setIfMax 2, channelId
      await self.outgoingChannel.setIfMax({ value: 2, data: channelId })

    // if another process in currently creating the channel
    } else if (result.value === STATE_CREATING_CHANNEL) {
      // poll for channelId
      while (self.outgoingChannel.getMax().value !== STATE_CHANNEL) { await sleep(5000) }
      channelId = self.outgoingChannel.getMax().data
    }

    // TODO: recreate channel if it doesn't exist
    self.outgoingPaymentChannelId = channelId
    self.outgoingPaymentChannel = await self.api.getPaymentChannel(channelId)

    // query peer until they have a channel id
    while (true) {
      self.incomingPaymentChannelId = await ctx.rpc.call('ripple_channel_id', self.prefix, [])
      if (self.incomingPaymentChannelId) break
      await sleep(5000)
    }

    // look up channel on ledger
    try {
      self.incomingPaymentChannel = await self.api.getPaymentChannel(self.incomingPaymentChannelId)
    } catch (err) {
      if (err.name === 'RippledError' && err.message === 'entryNotFound') {
        debug('incoming payment channel does not exit:', self.incomingPaymentChannelId)
      }
      throw err
    }
  },

  disconnect: async function (ctx) {
    const self = ctx.state
    // submit latest claim
    const { value, data } = await self.incomingClaim.getMax()
    try {
      await claimFunds(self, value, data)
    } catch (err) {
      debug(err)
    }

    // TODO: close channel?
    // return nothing
  },

  getAccount: ctx => ctx.state.prefix + ctx.state.address,
  getPeerAccount: ctx => ctx.state.prefix + ctx.state.peerAddress,
  getInfo: ctx => ({
    currencyCode: 'XRP',
    currencyScale: 6,
    prefix: ctx.state.prefix,
    connectors: [ ctx.state.prefix + ctx.state.peerAddress ]
  }),

  handleIncomingPrepare: async function (ctx, transfer) {
    const self = ctx.state

    if (self.incomingPaymentChannel === null) {
      throw new Error('incoming payment channel must be established ' +
        'before incoming transfers are processed')
    }

    // check that the unsecure amount does not exceed the limit
    const incoming = await ctx.transferLog.getIncomingFulfilledAndPrepared()
    const amountSecured = await self.incomingClaim.getMax()
    const exceeds = new BigNumber(incoming)
      .minus(amountSecured.value)
      .greaterThan(self.maxUnsecured)

    // make sure channel isn't closing
    // return nothing, or throw an error if invalid
    if (exceeds) {
      throw new Error(transfer.id + ' exceeds max unsecured balance of ', self.maxUnsecured)
    }
  },

  createOutgoingClaim: async function (ctx, outgoingBalance) {
    // generate claim for amount
    const self = ctx.state
    const encodedClaim = encodeClaim(outgoingBalance, self.outgoingPaymentChannelId)

    // sign a claim
    const signature = nacl.sign.detached(encodedClaim, self.keyPair.secretKey)

    debug(`signing outgoing claim for ${outgoingBalance} drops on ` +
      `channel ${self.outgoingPaymentChannelId}`)

    // issue a fund tx if required
    //   tell peer about fund tx

    // return claim+amount
    return {
      amount: outgoingBalance,
      signature: Buffer.from(signature).toString('hex')
    }
  },

  handleIncomingClaim: async function (ctx, claim) {
    // get claim+amount
    const self = ctx.state
    const { amount, signature } = claim
    debug(`received claim for ${amount} drops on channel ${self.incomingPaymentChannelId}`)

    const encodedClaim = encodeClaim(amount, self.incomingPaymentChannelId)
    let valid = false
    try {
      valid = nacl.sign.detached.verify(
        encodedClaim,
        Buffer.from(signature, 'hex'),
        Buffer.from(self.incomingPaymentChannel.publicKey.substring(2), 'hex')
      )
    } catch (err) {
      debug('verifying signature failed:', err.message)
    }
    // TODO: better reconciliation if claims are invalid
    if (!valid) {
      debug(`got invalid claim signature ${signature} for amount ${amount} drops`)
      throw new Error('got invalid claim signature ' +
        signature + ' for amount ' + amount + ' drops')
    }

    // validate claim against balance
    if (new BigNumber(amount).gt(self.incomingPaymentChannel.amount)) {
      debug('got claim for higher amount', amount,
        'than channel balance', self.incomingPaymentChannel.amount)
      throw new Error('got claim for higher amount ' + amount +
        ' than channel balance ' + self.incomingPaymentChannel.amount)
    }

    // issue claim tx if required
    // store in max value tracker, throw error if invalid
    await self.incomingClaim.setIfMax({
      value: amount,
      data: signature
    })
  }
})
