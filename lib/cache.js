var LRU = require('lru-cache');
var CACHE_SIZE = 1000;
var debug = require('debug')('ev:cache');
var crypto = require('crypto');

var evcache = global.evcache = new LRU({
    max: CACHE_SIZE,
    dispose: function(key, value) {
        debug('removing promise: ', key, ' from cache');
    }
});

function md5(modelName, filter) {
    return modelName + '_' + crypto.createHash('md5').update(JSON.stringify(filter)).digest('hex');
}

function getFromCache(modelName, filter) {
    var key = md5(modelName, filter);
    return evcache.get(key);
}

function cache(modelName, filter, promise) {
    var key = md5(modelName, filter);
    evcache.set(key, promise);
}


function cacheable(model) {
    if (global.evcacheables && global.evcacheables[model]) {
        debug('EV_CACHE', 'function cacheable(model): Model found to be cacheable:', model);
        return true;
    }
    debug('EV_CACHE', 'function cacheable(model): Model NOT cacheable:', model);
    return false;
}

function remove(modelName, filter) {
    var key = md5(modelName, filter);
    evcache.del(key);
}

function evict(modelName) {
    var counter = 0;
    evcache.keys().forEach(function(key) {
        if(key.indexOf(modelName + '_') === 0) {
            evcache.del(key);
            counter++;
        }
    })
    debug('evicted ', counter, ' queries from cache');
}

module.exports.cache = cache;
module.exports.getFromCache = getFromCache;
module.exports.cacheable = cacheable;
module.exports.remove = remove;
module.exports.evict = evict;
