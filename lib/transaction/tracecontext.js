'use strict'

const logger = require('../logger').child({component: 'TraceContext'})
const hashes = require('../util/hashes')

const TRACE_CONTEXT_PARENT_HEADER = 'traceparent'
const TRACE_CONTEXT_STATE_HEADER = 'tracestate'
const PARENT_TYPES = ['App', 'Browser', 'Mobile']

const W3C_TRACEPARENT_VERSION = '00'
const NR_TRACESTATE_VERSION = 0

// 255 (ff) explicitly not allowed for version
const VERSION_VALID_RGX = /^((?![f]{2})[a-f0-9]{2})$/
const TRACEID_VALID_RGX = /^((?![0]{32})[a-f0-9]{32})$/
const PARENTID_VALID_RGX = /^((?![0]{16})[a-f0-9]{16})$/
const FLAGS_VALID_RGX = /^([a-f0-9]{2})$/

const FLAGS = {
  sampled: 0x00000001
}

/**
 * The class reponsible for accepting, validating, and producing w3c tracecontext headers.
 */
class TraceContext {
  /**
   * Create a TraceContext object
   * @param {Transaction} transaction - a transaction object to attach to.
   */
  constructor(transaction) {
    this.transaction = transaction
    this.tracingVendors = null
    this.trustedParentId = null
    this._traceStateRaw = null
    this.flags = {
      get sampled() {
        return transaction.sampled
      }
    }
  }

  get traceparent() {
    // TODO: ensure ID's are correct length
    let traceId = this.transaction.getTraceId()
    traceId = traceId.padStart(32, '0')

    const segment = this.transaction.agent.tracer.getSegment()

    // If no segment/span is in context, we generate one
    // so we can have a valid traceparent.
    // TODO: Ensure ID length correct.
    let parentId = segment && segment.id
    parentId = parentId || hashes.makeId()
    parentId = parentId.padStart(16, '0')

    return `${W3C_TRACEPARENT_VERSION}-${traceId}-${parentId}-${this.createFlagsHex()}`
  }

  get tracestate() {
    const config = this.transaction.agent.config
    const trustedAccountKey = config.trusted_account_key
    const version = NR_TRACESTATE_VERSION
    const parentType = PARENT_TYPES.indexOf('App')
    const appId = config.primary_application_id
    const accountId = config.account_id

    // If no segment/span is in context, we do not send one as
    // we technically do not have a "span" on the agent side and
    // this trace data is newrelic specific.
    // TODO: Ensure spanId is the correct length.
    let spanId = ''
    if (config.span_events.enabled) {
      const segment = this.transaction.agent.tracer.getSegment()
      if (segment) {
        spanId = segment.id
      }
    }

    const transactionId = config.transaction_events.enabled ? this.transaction.id : ''
    const sampled = this.transaction.sampled ? '1' : '0'
    const priority = this.transaction.priority ? this.transaction.priority.toFixed(6) : ''
    const timestamp = Date.now()

    const nrTraceState = `${trustedAccountKey}@nr=${version}-${parentType}-${accountId}` +
      `-${appId}-${spanId}-${transactionId}-${sampled}-${priority}-${timestamp}`

    if (this._traceStateRaw) {
      return `${nrTraceState},${this._traceStateRaw}`
    }

    return nrTraceState
  }

  /**
   * Returns Trace Context headers to be used for outbound HTTP requests
   */
  createTraceContextPayload() {
    this.transaction.agent.recordSupportability('TraceContext/Create/Success')
    return {
      [TRACE_CONTEXT_PARENT_HEADER]: this.traceparent,
      [TRACE_CONTEXT_STATE_HEADER]: this.tracestate
    }
  }

  /**
   * Takes a headers object and modifies it in place by adding Trace Context headers
   * @param {object} headers - Headers for an HTTP request
   */
  addTraceContextHeaders(headers) {
    // This gets the transaction object to calculate priority and set the sampled property
    const traceContextHeaders = this.createTraceContextPayload()
    Object.assign(headers, traceContextHeaders)
  }

  /**
   * @typedef TraceContextData
   * @property {boolean} acceptedTraceparent - Whether a W3C traceparent headers was
   * parsed, validated, and accepted
   * @property {boolean} acceptedTracestate - Whether a New Relic tracestate headers was
   * parsed, validated, and accepted
   * @property {boolean} entryValid - Whether the matching NR tracestate string is valid
   * @property {Intrinsics} intrinsics - All the parts of the New Relic tracestate string
   * parsed and split out into an object
   * @property {string} newTraceState - The raw tracestate without the New Relic entry
   */

  /**
   * Takes a TraceContext headers from an HTTP request, parses them, validates them, and
   * applies the values to the internal state, returning an object with the
   * relevant Trace Context data and validation information.
   *
   * @param {string} traceparent - W3C traceparent header from an HTTP request
   * @param {string} tracestate - W3C tracestate header from an HTTP request
   * @returns {Object} returns an Object with the traceparent data and validation info
   */
  acceptTraceContextPayload(traceparent, tracestate) {
    const traceContextData = {
      acceptedTraceparent: false,
      acceptedTracestate: false,
      acceptedNRTracestate: false,
      traceId: null,
      parentSpanId: null,
      parentType: null,
      accountId: null,
      appId: null,
      transactionId: null,
      sampled: null,
      priority: null,
      transportDuration: null
    }

    //
    // Parsing traceparent
    //
    if (!traceparent) {
      // From the W3C spec: If the vendor failed to parse traceparent, it MUST NOT
      // attempt to parse tracestate
      return traceContextData
    }

    logger.trace('Accepting TraceContext for transaction %s', this.transaction.id)
    const parsedParent = this._validateAndParseTraceParentHeader(traceparent)

    // Log if there is a version mismatch in traceparent
    if (parsedParent.version !== W3C_TRACEPARENT_VERSION) {
      logger.trace(
        'Incoming traceparent version: %s, agent traceparent version: %s',
        parsedParent.version,
        W3C_TRACEPARENT_VERSION
      )
    }

    if (parsedParent.entryValid) {
      logger.trace('Accepted traceparent for transaction %s', this.transaction.id)
      traceContextData.acceptedTraceparent = true

      traceContextData.traceId = parsedParent.traceId
      traceContextData.parentSpanId = parsedParent.parentId
    } else {
      logger.trace(
        'Invalid traceparent for transaction %s: %s',
        this.transaction.id,
        traceparent
      )

      this.transaction.agent.recordSupportability(
        'TraceContext/TraceParent/Parse/Exception'
      )
      // From the W3C spec: If the vendor failed to parse traceparent, it MUST NOT
      // attempt to parse tracestate
      return traceContextData
    }

    //
    // Parsing tracestate
    //
    if (!tracestate) {
      logger.trace('No tracestate for transaction %s', this.transaction.id)
      return traceContextData
    }

    const parsedState = this._validateAndParseTraceStateHeader(tracestate)

    if (!parsedState.traceStateValid) {
      logger.trace('Invalid tracestate for transaction %s: %s',
        this.transaction.id,
        tracestate
      )
      return traceContextData
    }

    // Keep the raw, non-NewRelic tracestate string stored so that we can propogate it
    this._traceStateRaw = parsedState.newTraceState

    // These need to be kept to be added to root span events as an attribute
    this.tracingVendors = parsedState.vendors.join(',')

    if (
      parsedState.intrinsics &&
      parsedState.intrinsics.version !== NR_TRACESTATE_VERSION
    ) {
      logger.trace(
        'Incoming tracestate version: %s, agent tracestate version: %s',
        parsedState.intrinsics.version,
        NR_TRACESTATE_VERSION
      )
    }

    if (parsedState.entryValid) {
      logger.trace('Accepted tracestate for transaction %s', this.transaction.id)
      traceContextData.acceptedTracestate = true

      traceContextData.parentType = parsedState.intrinsics.parentType
      traceContextData.accountId = parsedState.intrinsics.accountId
      traceContextData.appId = parsedState.intrinsics.appId
      traceContextData.transactionId = parsedState.intrinsics.transactionId
      traceContextData.sampled = parsedState.intrinsics.sampled
      traceContextData.priority = parsedState.intrinsics.priority
      traceContextData.transportDuration =
        Math.max(0, (Date.now() - parsedState.intrinsics.timestamp) / 1000)

      this.trustedParentId = parsedState.intrinsics.spanId
      this._traceStateRaw = parsedState.newTraceState

      this.transaction.agent.recordSupportability('TraceContext/Accept/Success')
    } else if (parsedState.entryFound) {
      logger.error('Invalid tracestate for transaction %s: %s',
        this.transaction.id, tracestate)
      this.transaction.agent.recordSupportability(
        'TraceContext/TraceState/InvalidNrEntry'
      )
    }

    return traceContextData
  }

  /**
   * Validate a traceparent header string and return an object with the relevant parts
   * parsed out if valid.
   *
   * @param {string} traceparent - a W3C traceparent header string
   * @returns {Object} returns an Object with the traceparent data and validation info
   */
  _validateAndParseTraceParentHeader(traceparent) {
    const traceParentInfo = {
      entryValid: false,
      version: null,
      traceId: null,
      parentId: null,
      flags: null
    }

    if (!traceparent) {
      return traceParentInfo
    }

    const parts = traceparent.split('-')

    // No extra data allowed this version.
    if (parts[0] === W3C_TRACEPARENT_VERSION && parts.length !== 4) {
      return traceParentInfo
    }

    const [version, traceId, parentId, flags] = parts
    const isValid =
      version.match(VERSION_VALID_RGX) &&
      traceId.match(TRACEID_VALID_RGX) &&
      parentId.match(PARENTID_VALID_RGX) &&
      flags.match(FLAGS_VALID_RGX)

    if (isValid) {
      traceParentInfo.entryValid = true
      traceParentInfo.version = version
      traceParentInfo.traceId = traceId
      traceParentInfo.parentId = parentId
      traceParentInfo.flags = flags
    }

    return traceParentInfo
  }

  // Not used now, but will be useful when traceparent has more flags
  parseFlagsHex(flags) {
    const flagsInt = parseInt(flags, 16)
    return Object.keys(FLAGS).reduce((o, key) => {
      o[key] = Boolean(flagsInt & FLAGS[key])
      return o
    }, {})
  }

  createFlagsHex() {
    const flagsNum = Object.keys(this.flags).reduce((num, key) => {
      if (this.flags[key]) {
        num += FLAGS[key]
      }
      return num
    }, 0)
    return flagsNum.toString(16).padStart(2, '0')
  }

  /**
   * @typedef TraceStateData
   * @property {boolean} entryFound - Whether a New Relic tracestate string with a match
   * trusted account key field is found
   * @property {boolean} entryValid - Whether the matching NR tracestate string is valid
   * @property {string} entryInvalidReason - Why the tracestate did not validate
   * @property {Intrinsics} intrinsics - All the parts of the New Relic tracestate string
   * parsed and split out into an object
   * @property {string} newTraceState - The raw tracestate without the New Relic entry
   * @property {array} vendors - All the vendor strings found in the tracestate
   */

  /**
   * Accepts a W3C tracestate header string and returns an object with information about
   * the validity and intrinsics of the parsed tracestate string
   *
   * @param {string} tracestate - A raw W3C tracestate header string
   * @returns {TraceStateData} returns an object with validation information and
   * instrinsics on any relevant New Relic tracestate strings found
   */
  _validateAndParseTraceStateHeader(tracestate) {
    let tsd = {
      entryFound: false,
      entryValid: undefined,
      entryInvalidReason: undefined,
      traceStateValid: undefined,
      intrinsics: undefined,
      newTraceState: undefined,
      vendors: undefined
    }

    const listMembers = tracestate.split(',')

    // Verify key/value pairs are parsed correctly while getting vendors
    tsd.vendors = listMembers.map(lm => {
      const split = lm.split('=')
      if (split.length !== 2) {
        tsd.traceStateValid = false
        return
      }
      return split[0]
    })

    // Verify all the key/value pairs were parsed correctly
    if (tsd.traceStateValid === false) return tsd

    // Tracestate parsed correctly
    tsd.traceStateValid = true

    // See if there's a New Relic Trace State
    const trustedKey = this.transaction.agent.config.trusted_account_key
    // TODO: this doesn't catch problematic inbound payloads with multiple NR
    // entries with the same trusted key
    const nrVendorIndex = tsd.vendors.findIndex(v => v === `${trustedKey}@nr`)
    if (nrVendorIndex >= 0) {
      tsd.entryFound = true

      // Remove the new relic entry that we found from the vendors and listMembers array
      tsd.vendors.splice(nrVendorIndex, 1)
      const nrTraceStateEntry = listMembers.splice(nrVendorIndex, 1)[0]
      const nrTraceStateValue = nrTraceStateEntry.split('=')[1]

      const intrinsicsValidation = this._validateAndParseIntrinsics(nrTraceStateValue)
      if (intrinsicsValidation.entryValid) {
        tsd.entryValid = true
        tsd.intrinsics = intrinsicsValidation
        delete tsd.intrinsics.entryValid
      } else {
        tsd.entryInvalidReason = intrinsicsValidation.invalidReason
        tsd.entryValid = false
      }
    }

    // Rebuild the new strace state string without the new relic entry
    tsd.newTraceState = listMembers.join(',')

    return tsd
  }

  /**
   * @typedef Intrinsics
   * @property {number} version - TraceContext spec version used
   * @property {number} parentType - The type of component that produced this tracestate
   * @property {string} accountId
   * @property {string} appId
   * @property {string} spanId
   * @property {string} transactionId
   * @property {integer} sampled - 1 or 0, whether the receiving agent should sample
   * @property {number} priority - floating point of the priority the agent should use,
   * rounded to 6 decimal places
   * @property {number} timestamp - when the payload was created, milliseconds since epoch
   * @property {boolean} entryValid - if all entries in the Intrinsics object is valid
   */

  /**
   * Accepts a New Relic intrinsics string and returls a validation object w/
   * the validity and intrinsics of the tracestate
   *
   * @param {string} nrTracestateValue - The value part of a New Relic tracestate entry
   * @returns {Intrinsics} returns an Intrinsics object with validation information and
   * instrinsics on any relevant New Relic tracestate strings found
   */
  _validateAndParseIntrinsics(nrTracestateValue) {
    const intrinsics = this._parseIntrinsics(nrTracestateValue)

    // Functions that return true when the field is invalid
    const isNull = v => v == null
    const intrinsicInvalidations = {
      version: isNaN,     // required, int
      parentType: isNull, // required, str
      accountId: isNull,  // required, str
      appId: isNull,      // required, str
      sampled:  v => v == null ? false : isNaN(v), // not required, int
      priority: v => v == null ? false : isNaN(v), // not required, float
      timestamp: isNaN    // required, int
    }


    // If a field is found invalid, flag the entry as not valid
    intrinsics.entryValid = true
    for (const key of Object.keys(intrinsicInvalidations)) {
      const invalidation = intrinsicInvalidations[key]
      if (invalidation && invalidation(intrinsics[key])) {
        intrinsics.entryValid = false
        intrinsics.entryInvalidReason = `${key} failed invalidation test`
      }
    }

    // Convert to types expected by Transaction
    intrinsics.sampled = Boolean(intrinsics.sampled)
    intrinsics.parentType = PARENT_TYPES[intrinsics.parentType]
    if (!intrinsics.parentType) intrinsics.entryValid = false

    return intrinsics
  }

  /**
   * Parses intrinsics of a New Relic tracestate entry's value
   */
  _parseIntrinsics(nrTracestateValue) {
    const intrinsics = this._extractTraceStateIntrinsics(nrTracestateValue)

    const intrinsicConversions = {
      version: parseInt,
      parentType: parseInt,

      // these two can be null, don't try to parse a null
      sampled: v => v == null ? v : parseInt(v, 10),
      priority: v => v == null ? v : parseFloat(v),

      timestamp: parseInt,
    }

    for (const key of Object.keys(intrinsicConversions)) {
      const conversion = intrinsicConversions[key]
      if (conversion) {
        intrinsics[key] = conversion(intrinsics[key])
      }
    }

    return intrinsics
  }

  _extractTraceStateIntrinsics(nrTracestate) {
    const splitValues = nrTracestate.split('-')

    // convert empty strings to null
    splitValues.forEach((value, i) => {
      if (value === '') splitValues[i] = null
    })

    const intrinsics = {
      version: splitValues[0],
      parentType: splitValues[1],
      accountId: splitValues[2],
      appId: splitValues[3],
      spanId: splitValues[4],
      transactionId: splitValues[5],
      sampled: splitValues[6],
      priority: splitValues[7],
      timestamp: splitValues[8]
    }

    return intrinsics
  }
}

module.exports.TraceContext = TraceContext
module.exports.TRACE_CONTEXT_PARENT_HEADER = TRACE_CONTEXT_PARENT_HEADER
module.exports.TRACE_CONTEXT_STATE_HEADER = TRACE_CONTEXT_STATE_HEADER