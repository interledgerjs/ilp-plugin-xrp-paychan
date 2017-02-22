'use strict'

const bignum = require('bignum')
const crypto = require('crypto')
const addressCodec = require('ripple-address-codec')

function channelId (src, dest, sequence) {
  const buffer = Buffer.concat([
    Buffer.from('x', 'ascii'),
    Buffer.from(addressCodec.decodeAccountID(src)),
    Buffer.from(addressCodec.decodeAccountID(dest)),
      bignum(sequence)
      .toBuffer({ endian: 'big', size: 4 })
  ])

  return sha512half(buffer).toString('hex').toUpperCase()
}

const omit = (obj, field) => Object.assign({}, obj, { [field]: undefined })
const sha256 = (m) => crypto.createHash('sha256').update(m, 'utf8').digest()
const sha512half = (buf) => crypto.createHash('sha512')
  .update(buf)
  .digest()
  .slice(0, 256)

module.exports = {
  omit,
  sha256,
  sha512half,
  channelId
}
