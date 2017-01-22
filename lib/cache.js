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

var actorcache = global.actorcache = new LRU({
    max: CACHE_SIZE,
    dispose: function (key, value) {
        debug('removing actor promise: ', key, ' from cache');
    }
});


function isActor(model) {
    if (model.modelName === 'BaseActorEntity') {
        return true;
    } else if (!model.base) {
        return false;
    }
    return isActor(model.base);
}


function findIdInWhere(where) {
    return Object.keys(where).some(function (k) {
        var cond = where[k];
        if (k === 'id') {
            return true;
        }
        if (k === 'and' || k === 'or' || k === 'nor') {
            if (Array.isArray(cond)) {
                return cond.some(function (c) {
                    return findIdInWhere(c);
                });
            }
        }
        return false;
    });
}



function isInstanceQuery(filter) {
    if (filter.limit === 1 && findIdInWhere(filter.where)) {
        return true;
    } else {
        return false;
    }
}

function md5(modelName, filter) {
    return modelName + '_' + crypto.createHash('md5').update(JSON.stringify(filter)).digest('hex');
}

function getFromCache(model, filter) {
    var modelName = model.modelName;
    var key = md5(modelName, filter);
    if (isActor(model) && isInstanceQuery(filter)) {
        return actorcache.get(key);
    } else {
        return evcache.get(key);
    }
}

function cache(model, filter, promise) {
    var modelName = model.modelName;
    if (cacheable(modelName)) {
        var key = md5(modelName, filter);
        if (isActor(model) && isInstanceQuery(filter)) {
            actorcache.set(key, promise);
        } else {
            evcache.set(key, promise);
        }
    }
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
    if (isActor(model) && isInstanceQuery(filter)) {
        actorcache.del(key);
    } else {
        evcache.del(key);
    }
}

module.exports.cache = cache;
module.exports.getFromCache = getFromCache;
module.exports.cacheable = cacheable;
module.exports.remove = remove;
