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
const assert = require('assert')

// constants
const DEFAULT_REFUND_THRESHOLD = 0.9
const DEFAULT_SETTLE_DELAY = 60
const {
  STATE_NO_CHANNEL,
  STATE_CREATING_CHANNEL,
  STATE_CHANNEL,
  POLLING_INTERVAL,
  xrpToDrops,
  dropsToXrp,
  sleep
} = require('./src/lib/constants')

// utility functions
const randomTag = () => bignum.fromBuffer(crypto.randomBytes(4), {
  endian: 'big',
  size: 4
}).toNumber()

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

async function reloadIncomingChannelDetails (ctx) {
  const self = ctx.state
  debug('quering peer for incoming channel id')
  self.incomingPaymentChannelId = await ctx.rpc.call('ripple_channel_id', self.prefix, [])
  if (!self.incomingPaymentChannelId) {
    debug('peer did not return incoming channel id')
    return
  }

  // look up channel on ledger
  try {
    self.incomingPaymentChannel = await self.api.getPaymentChannel(self.incomingPaymentChannelId)
    debug('validated that incoming payment channel exists')
  } catch (err) {
    if (err.name === 'RippledError' && err.message === 'entryNotFound') {
      debug('incoming payment channel does not exit:', self.incomingPaymentChannelId)
    }
    self.incomingPaymentChannelId = null
    throw err
  }
}

function validateOpts (opts) {
  // TODO: validate plugin options
  // mandatory
  assert(opts.rippledServer, 'rippledServer is required')
  assert(opts.address, 'address is required')
  assert(opts.secret, 'secret is required')
  assert(opts.peerAddress, 'peerAddress is required')
  assert(opts.maxAmount, 'maxAmount is required')
  assert(opts.maxUnsecured, 'maxUnsecured is required')

  // optional
  if (opts.fundThreshold) {
    assert(parseFloat(opts.fundThreshold) > 0 && parseFloat(opts.fundThreshold) <= 1)
  }
}

module.exports = makePaymentChannelPlugin({
  pluginName: 'xrp-paychan',

  constructor: function (ctx, opts) {
    validateOpts(opts)

    const self = ctx.state
    self.rippledServer = opts.rippledServer
    self.api = new RippleAPI({ server: opts.rippledServer })
    self.address = opts.address
    self.secret = opts.secret
    self.peerAddress = opts.peerAddress
    self.maxAmount = opts.maxAmount
    self.maxUnsecured = opts.maxUnsecured
    self.fundThreshold = opts.fundThreshold || DEFAULT_REFUND_THRESHOLD
    // self.claimThreshold = opts.claimThreshold // TODO: implement automatic claiming if threshold is reached
    self.prefix = opts.prefix // TODO: auto-generate prefix?
    self.authToken = opts.token
    self.settleDelay = opts.settleDelay || DEFAULT_SETTLE_DELAY

    // TODO: figure out best way to create secure keypair
    self.keyPair = nacl.sign.keyPair.fromSeed(sha256(Buffer.from(self.secret)))
    self.outgoingChannel = ctx.backend.getMaxValueTracker('outgoing_channel')
    self.incomingClaim = ctx.backend.getMaxValueTracker('incoming_claim')
    self.incomingClaimSubmitted = ctx.backend.getMaxValueTracker('incoming_claim_submitted')

    ctx.rpc.addMethod('ripple_channel_id', () => {
      if (!self.incomingPaymentChannelId) {
        setImmediate(reloadIncomingChannelDetails.bind(null, ctx))
      }
      return self.outgoingPaymentChannelId || null
    })
  },

  getAuthToken: (ctx) => (ctx.state.authToken),

  connect: async function (ctx) {
    const self = ctx.state
    debug('connecting to rippled server:', self.rippledServer)
    try {
      await self.api.connect()

      await self.api.connection.request({
        command: 'subscribe',
        accounts: [ self.address, self.peerAddress ]
      })
    } catch (err) {
      debug('error connecting to rippled server', err)
      throw new Error('Error connecting to rippled server: ' + err.message)
    }
    debug('connected to rippled server')

    // open payment channel
    let channelId
    const highest = await self.outgoingChannel.getMax()
    if (highest.value === STATE_CHANNEL) { // channel exists
      channelId = highest.data
      debug('using existing payment channel:', channelId)
    } else { // create channel
      const pluginId = uuid()
      const tryToCreate = { value: STATE_CREATING_CHANNEL, data: pluginId }
      const result = await self.outgoingChannel.setIfMax(tryToCreate)

      // if the payment channel has not been created and this process must create it
      if (result.value === STATE_NO_CHANNEL) {
        debug('creating new payment channel')
        const txTag = randomTag()
        let tx
        try {
          tx = await self.api.preparePaymentChannelCreate(self.address, {
            amount: dropsToXrp(self.maxAmount),
            destination: self.peerAddress,
            settleDelay: self.settleDelay,
            publicKey: 'ED' + Buffer.from(self.keyPair.publicKey).toString('hex').toUpperCase(),
            sourceTag: txTag
          })
        } catch (e) {
          debug('Error preparing payment channel.', e)
          throw e
        }

        debug('created paymentChannelCreate tx', tx.txJSON)

        const signedTx = self.api.sign(tx.txJSON, self.secret)
        let resultCode
        let resultMessage
        try {
          const result = await self.api.submit(signedTx.signedTransaction)
          resultCode = result.resultCode
          resultMessage = result.resultMessage
        } catch (err) {
          debug('error submitting paymentChannelCreate', err)
          throw new Error('Error creating payment channel: ' + err.message)
        }
        if (resultCode !== 'tesSUCCESS') {
          const message = 'Error creating the payment channel: ' + resultCode + ' ' + resultMessage
          debug(message)
          throw new Error(message)
        }

        debug('submitted paymentChannelCreate, waiting for tx to be validated (this may take a few seconds)')
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
        debug('payment channel successfully created: ', channelId)

        await self.outgoingChannel.setIfMax({ value: STATE_CHANNEL, data: channelId })
      } else if (result.value === STATE_CREATING_CHANNEL) {
      // if another process is currently creating the channel poll for channelId
        debug(`polling for channelId (plugin id ${pluginId})`)
        while ((await self.outgoingChannel.getMax()).value !== STATE_CHANNEL) {
          await sleep(POLLING_INTERVAL)
        }
        channelId = (await self.outgoingChannel.getMax()).data
      }
    }

    // TODO: recreate channel if it doesn't exist
    self.outgoingPaymentChannelId = channelId
    self.outgoingPaymentChannel = await self.api.getPaymentChannel(channelId)

    await reloadIncomingChannelDetails(ctx)
  },

  disconnect: async function (ctx) {
    debug('disconnecting payment channel')
    const self = ctx.state
    // submit latest claim
    const { value, data } = await self.incomingClaim.getMax()
    const claimedValue = (await self.incomingClaimSubmitted.getMax()).value
    try {
      if (claimedValue < value) {
        await claimFunds(self, value, data)
      }
    } catch (err) {
      debug(err)
    }

    // TODO: close channel?
    // return nothing
  },

  getAccount: ctx => ctx.plugin._prefix + ctx.state.address,
  getPeerAccount: ctx => ctx.plugin._prefix + ctx.state.peerAddress,
  getInfo: ctx => ({
    currencyCode: 'XRP',
    currencyScale: 6,
    prefix: ctx.plugin._prefix,
    connectors: [ ctx.plugin._prefix + ctx.state.peerAddress ]
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
      throw new Error(transfer.id + ' exceeds max unsecured balance of: ', self.maxUnsecured)
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

    // TODO: issue a fund tx if self.fundPercent is reached and tell peer about fund tx
    if (outgoingBalance > self.maxAmount * self.fundThreshold) {
      debug('outgoing channel threshold reached, adding more funds')
      const xrpAmount = dropsToXrp(self.maxAmount)
      const tx = await self.api.preparePaymentChannelFund(self.address, {
        amount: xrpAmount,
        channel: self.outgoingPaymentChannelId
      })

      debug('submitting channel fund tx', tx)
      const signedTx = self.api.sign(tx.txJSON, self.secret)
      const {resultCode, resultMessage} = await self.api.submit(signedTx.signedTransaction)
      if (resultCode !== 'tesSUCCESS') {
        debug(`Failed to add ${xrpAmount} XRP to channel ${self.channelId}: `, resultMessage)
      }

      const handleTransaction = async function (ev) {
        if (ev.transaction.hash !== signedTx.id) return

        if (ev.engine_result === 'tesSUCCESS') {
          debug(`successfully funded channel for ${xrpAmount} XRP`)
          const { amount } = await self.api.getPaymentChannel(self.outgoingPaymentChannelId)
          self.maxAmount = xrpToDrops(amount)
        } else {
          debug('funding channel failed ', ev)
        }

        setImmediate(() => self.api.connection
          .removeListener('transaction', handleTransaction))
      }
      self.api.connection.on('transaction', handleTransaction)
    }

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
    const channelBalance = xrpToDrops(self.incomingPaymentChannel.amount)
    if (new BigNumber(amount).gt(channelBalance)) {
      const message = 'got claim for amount higher than channel balance. amount: ' + amount + ', incoming channel balance: ' + channelBalance
      debug(message)
      throw new Error(message)
    }

    // TODO: issue claim tx if self.claimPercent is exceeded
    // store in max value tracker, throw error if invalid
    await self.incomingClaim.setIfMax({
      value: amount,
      data: signature
    })
  }
})
