'use strict'

const BigNumber = require('bignumber.js')
const bignum = require('bignum')
const crypto = require('crypto')
const addressCodec = require('ripple-address-codec')

function channelId (src, dest, sequence) {
  const preimage = Buffer.concat([
    Buffer.from('\0\0\0x', 'ascii'),
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

function randomTag (src, dest, sequence) {
  return +bignum.fromBuffer(crypto.randomBytes(4), {
    endian: 'big',
    size: 4
  }).toString()
}

function dropsToXrp (n) {
  return (new BigNumber(n)).div('1000000').toString()
}

function xrpToDrops (n) {
  return (new BigNumber(n)).mul('1000000').round().toString()
}

//const omit = (obj, field) => Object.assign({}, obj, { [field]: undefined })
const sha256 = (m) => crypto.createHash('sha256').update(m, 'utf8').digest()

const toBuffer = (n, size) => bignum(n).toBuffer({
  endian: 'big',
  size: size
})

const wait = (timeout) => (new Promise((resolve, reject) => {
  if (!timeout) return
  setTimeout(() => {
    if (timeout) reject(new Error('timed out'))
  }, timeout)
}))

module.exports = {
  toBuffer,
  randomTag,
  sha256,
  wait,
  channelId,
  dropsToXrp,
  xrpToDrops
}
