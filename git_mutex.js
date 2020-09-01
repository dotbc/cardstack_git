const Mutex = require('async-mutex').Mutex
const mutex = new Mutex()

module.exports = mutex
