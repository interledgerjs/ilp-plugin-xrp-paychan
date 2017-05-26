const util = require('.')

const getClaimMessage = (channelId, amount) => {
  const hashPrefix = Buffer.from('CLM\0', 'ascii')
  const idBuffer = Buffer.from(channelId, 'hex')
  const amountBuffer = util.toBuffer(amount, 8)

  return Buffer.concat([
    hashPrefix, idBuffer, amountBuffer
  ])
}

module.exports = { getClaimMessage }
