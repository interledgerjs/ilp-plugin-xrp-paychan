'use strict'

const assert = require('assert')
const { spawn } = require('child_process')
const byline = require('byline')
const through2 = require('through2')

const masterAccount = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'
const masterSecret = 'snoPBrXtMeMyMHUVTgbuqAfg1SUTb'

function ledgerAccept (api) {
  const request = {command: 'ledger_accept'}
  return api.connection.request(request)
}

function autoAcceptLedger (api) {
  assert(typeof api.submit === 'function', 'parameter api must be of type RippleAPI')
  const originalSubmit = api.submit
  api.submit = async (...args) => {
    return originalSubmit.call(api, ...args).then((result) => {
      setTimeout(ledgerAccept.bind(null, api), 20)
      return result
    })
  }
}

function pay (api, from, to, amount, secret, currency = 'XRP', counterparty) {
  const paymentSpecification = {
    source: {
      address: from,
      maxAmount: {
        value: amount,
        currency: currency
      }
    },
    destination: {
      address: to,
      amount: {
        value: amount,
        currency: currency
      }
    }
  }

  if (counterparty !== undefined) {
    paymentSpecification.source.maxAmount.counterparty = counterparty
    paymentSpecification.destination.amount.counterparty = counterparty
  }

  let id = null
  return api.preparePayment(from, paymentSpecification, {})
    .then(data => api.sign(data.txJSON, secret))
    .then(signed => {
      id = signed.id
      return api.submit(signed.signedTransaction)
    })
    .then(() => ledgerAccept(api))
    .then(() => id)
}

function payTo (api, to, amount = '4003218', currency = 'XRP', counterparty) {
  return pay(api, masterAccount, to, amount, masterSecret, currency,
    counterparty)
}

function spawnParallel (cmd, args, opts, formatter) {
  const proc = spawn(cmd, args,
    Object.assign({}, opts, {stdio: 'pipe'}))

  // Add prefix to output to distinguish processes
  if (typeof formatter === 'function') {
    const stdoutStream = byline(proc.stdout).pipe(through2(formatter))
    const stderrStream = byline(proc.stderr).pipe(through2(formatter))

    // Increase event listener limit to avoid memory leak warning
    process.stdout.setMaxListeners(process.stdout.getMaxListeners() + 1)
    process.stderr.setMaxListeners(process.stderr.getMaxListeners() + 1)

    if (opts.waitFor) {
      stdoutStream.pipe(through2(function (line, enc, callback) {
        this.push(line)
        if (line.toString('utf-8').indexOf(opts.waitFor.trigger) !== -1) {
          opts.waitFor.callback()
        }
        callback()
      })).pipe(process.stdout)
    } else {
      stdoutStream.pipe(process.stdout)
    }
    stderrStream.pipe(process.stderr)

    proc.on('exit', () => {
      // Disconnect pipes
      stdoutStream.unpipe(process.stdout)
      stderrStream.unpipe(process.stderr)

      // Return to previous event emitter limit
      process.stdout.setMaxListeners(process.stdout.getMaxListeners() - 1)
      process.stderr.setMaxListeners(process.stderr.getMaxListeners() - 1)
    })
  } else {
    proc.stdout.on('data', (data) => process.stdout.write(data.toString()))
    proc.stderr.on('data', (data) => process.stderr.write(data.toString()))
  }

  // When a process dies, we should abort
  proc.on('exit', (code) => {
    if (code) {
      console.error('child exited with code ' + code)
      process.exit(1)
    }
  })

  return proc
}

module.exports = {
  pay,
  payTo,
  autoAcceptLedger,
  ledgerAccept,
  spawnParallel
}
