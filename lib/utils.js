'use strict'

const crypto = require('crypto')

/**
 * Generates a topic hash for Hyperswarm from a string
 *
 * @param {string} topicString - String to generate topic from
 * @returns {Buffer} - 32-byte buffer for Hyperswarm topic
 */
function generateTopic (topicString) {
  const hash = crypto.createHash('sha256')
  hash.update(topicString)
  return hash.digest()
}

module.exports = {
  generateTopic
}
