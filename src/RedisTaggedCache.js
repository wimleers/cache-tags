// @flow

const TaggedCache = require('./TaggedCache');
const Promise = require('bluebird');
const sha1 = require('sha1');

/**
 * Forever reference key.
 *
 * @var string
 */
const REFERENCE_KEY_FOREVER = 'forever_ref';
/**
 * Standard reference key.
 *
 * @var string
 */
const REFERENCE_KEY_STANDARD = 'standard_ref';

/**
 * Chunk an array into smaller arrays.
 *
 * @param {Array} array
 *   The array to chunk.
 * @param {number} chunkSize
 *   The number of items per chunk.
 *
 * @returns {Array[]}
 *   The array of chunks.
 *
 * @protected
 */
function chunkArray(array: Array<*>, chunkSize: number): Array<Array<*>> {
  let i;
  let j;
  const output = [];
  for (i = 0, j = array.length; i < j; i += chunkSize) {
    output.push(array.slice(i, i + chunkSize));
  }
  return output;
}

class RedisTaggedCache extends TaggedCache {
  /**
   * Store an item in the cache.
   *
   * @param {string} key
   * @param {mixed} value
   * @param {int} ttl
   * @return {Promise<void>}
   */
  set(key: string, value: any, ttl: ?number): Promise<void> {
    const reference = ttl ? REFERENCE_KEY_STANDARD : REFERENCE_KEY_FOREVER;
    return this.tags.getNamespace()
      .then(namespace => Promise.all([
        this.pushKeys(namespace, key, reference),
        super.set(key, value, ttl),
      ]));
  }

  /**
   * Increment the value of an item in the cache.
   *
   * @param {string} key
   * @param {mixed} value
   * @return {Promise<void>}
   */
  increment(key: string, value: any = 1): Promise<void> {
    const nsPromise = this.tags.getNamespace();
    return Promise.all([
      nsPromise.then(namespace => this.pushStandardKeys(namespace, key)),
      super.increment(key, value),
    ]);
  }

  /**
   * Decrement the value of an item in the cache.
   *
   * @param {string} key
   * @param {mixed} value
   * @return {Promise<void>}
   */
  decrement(key: string, value: any = 1): Promise<void> {
    const nsPromise = this.tags.getNamespace();
    return Promise.all([
      nsPromise.then(namespace => this.pushStandardKeys(namespace, key)),
      super.decrement(key, value),
    ]);
  }

  /**
   * Remove all items from the cache.
   *
   * @return {Promise<void>}
   */
  flush(): Promise<void> {
    return Promise.all([
      this.deleteForeverKeys(),
      this.deleteStandardKeys(),
    ])
      .then(() => super.flush());
  }

  /**
   * Store standard key references into store.
   *
   * @param {string} namespace
   * @param {string} key
   * @return {Promise<void>}
   */
  pushStandardKeys(namespace: string, key: string): Promise<void> {
    return this.pushKeys(namespace, key, REFERENCE_KEY_STANDARD);
  }

  /**
   * Store forever key references into store.
   *
   * @param {string} namespace
   * @param {string} key
   * @return {Promise<void>}
   */
  pushForeverKeys(namespace: string, key: string): Promise<void> {
    return this.pushKeys(namespace, key, REFERENCE_KEY_FOREVER);
  }

  /**
   * Store a reference to the cache key against the reference key.
   *
   * @param {string} namespace
   * @param {string} key
   * @param {string} reference
   * @return {Promise<void>}
   */
  pushKeys(namespace: string, key: string, reference: string): Promise<void> {
    const fullKey = `${this.store.options.keyPrefix}${sha1(namespace)}:${key}`;
    const pipeline = this.store.pipeline();
    namespace.split('|').forEach(segment => {
      const referenceKey = this.referenceKey(segment, reference);
      pipeline.sadd(referenceKey, fullKey);
    });
    return pipeline.exec();
  }

  /**
   * Delete all of the items that were stored forever.
   *
   * @return {Promise<void>}
   */
  deleteForeverKeys(): Promise<void> {
    return this.deleteKeysByReference(REFERENCE_KEY_FOREVER);
  }

  /**
   * Delete all standard items.
   *
   * @return {Promise<void>}
   */
  deleteStandardKeys(): Promise<void> {
    return this.deleteKeysByReference(REFERENCE_KEY_STANDARD);
  }

  /**
   * Find and delete all of the items that were stored against a reference.
   *
   * @param {string} reference
   * @return {void}
   */
  deleteKeysByReference(reference: string): Promise<void> {
    return this.tags.getNamespace()
      .then(namespace => {
        const referenceKeys = namespace.split('|')
          .map(segment => this.referenceKey(segment, reference));
        const promises = referenceKeys.map(referenceKey =>
          this.deleteValues(referenceKey));
        return Promise.all(promises).then(() => this.store.del(...referenceKeys));
      })
      .then(() => {});
  }

  /**
   * Delete item keys that have been stored against a reference.
   *
   * @param {string} referenceKey
   * @return {Promise<void>}
   */
  deleteValues(referenceKey: string): Promise<void> {
    return this.store.smembers(referenceKey)
      .then(members => Array.from(new Set(members)))
      .then(members => {
        if (!members) {
          return Promise.resolve();
        }
        return Promise.map(
          chunkArray(members, 1000),
          (chunk) => this.store.del(chunk),
          { concurrency: 100 }
        );
      })
      .then(() => {});
  }

  /**
   * Get the reference key for the segment.
   *
   * @param {string} segment
   * @param {string} suffix
   * @return {string}
   */
  referenceKey(segment: string, suffix: string): string {
    return `${this.tagPrefix}${segment}:${suffix}`;
  }
}

module.exports = RedisTaggedCache;
