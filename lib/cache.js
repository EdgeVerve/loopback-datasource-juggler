var LRU = require('lru-cache');
var _ = require('lodash');
var Promise = require('bluebird');
var debug = require('debug')('ev:cache');
var crypto = require('crypto');
var CACHE_SIZE = 1000;
var allowedKeys = ['_scope','_isDeleted'];
var util = require('util');

var instanceCache = global.instanceCache = {};
var queryCache = global.queryCache = {};
var lockCache = {};

function getOrCreateLRU(model, filter) {
    var modelName = model.modelName;
    var cache;
    if (isInstanceQuery(model, filter)) {
        cache = instanceCache;
    } else {
        cache = queryCache;
    }
    if (!cache[modelName]) {
        cache[modelName] = new LRU({
            max: CACHE_SIZE,
            dispose: function (key, value) {
                debug('removing actor promise: ', key, ' from cache');
            }
        });
    }
    return cache[modelName];
}

function getFields(data, arr) {
    _.forEach(data, function dataAccessGetKeysForEach(value, key) {
        if ((typeof key === 'string') && (key !== 'and' && key !== 'or')) {
            if (key.indexOf('.') > -1) {
                Array.prototype.splice.apply(arr, [0, 0].concat(key.split('.')));
            } else {
                arr.push({key:key, value: value});
            }
        } else if (typeof value === 'object') {
            getFields(value, arr);
        }
    });
}

function idName(m) {
    return m.definition.idName() || 'id';
}

function findIdInWhere(model, where) {
    var pk = idName(model);
    var whereConds = [];
    getFields(where, whereConds);
    return whereConds.find(function(cond) {
        return cond.key === pk;
    });
}

function findScopeInWhere(model, where) {
    var scopeField = '_scope';
    var whereConds = [];
    getFields(where, whereConds);
    return whereConds.find(function(cond) {
        return cond.key === scopeField;
    });
}

function inhertisFromBaseEntity(model) {
    if (model.modelName === 'BaseEntity') {
        return true;
    } else if (!model.base) {
        return false;
    }
    return inhertisFromBaseEntity(model.base);
}


function isInstanceQuery(model, filter) {
    if (!inhertisFromBaseEntity(model)) {
        return false;
    }
    var pk = idName(model);
    var whereConds = [];
    getFields(filter.where, whereConds);
    var pkValue = whereConds.find(function(cond) {
        return cond.key === pk;
    });
    if (pkValue !== undefined) {
        var modelAllowedKeys = [pk].concat(allowedKeys);
        var allowed = whereConds.reduce(function(result, cond) {
            if (!modelAllowedKeys.includes(cond.key)) {
                return false;
            } else {
                return result;
            }
        }, true);
        if (allowed) {
            return true;
        } else {
            return false;
        }
    } else {
        return false;
    }
}

function createKey(model, filter) {
    var key;
    if (isInstanceQuery(model, filter)) {
        key = findIdInWhere(model, filter.where).value;
        if  (!key) {
            debug('EV_CACHE','findIdInWhere failed for model :', model.modelName,' with filter: ', util.inspect(filter,{depth:null}));
            return undefined;
        } else if(typeof key !== 'string') {
            key = JSON.stringify(key);
        }
        var scopeValue = findScopeInWhere(model,filter.where);
        if (scopeValue) {
            key += JSON.stringify(scopeValue.value);
        }
    } else if (cacheable(model.modelName)) {
        key = md5(filter);
    }
    return key;
}

function md5(filter) {
    return crypto.createHash('md5').update(JSON.stringify(filter)).digest('hex');
}

function getFromCache(model, filter) {
    var cache = getOrCreateLRU(model, filter);
    var key = createKey(model, filter);
    return cache.get(key);
}

function cache(model, filter, promise) {
    var cache = getOrCreateLRU(model, filter);
    var key = createKey(model, filter);
    if (key) {
        return cache.set(key, promise);
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

function update(model, where, data) {
    var filter = {where: where};
    if (isInstanceQuery(model, filter)) {
        var cache = getOrCreateLRU(model, filter);
        var key = createKey(model, filter);
        var promise = cache.get(key);
        if (promise) {
            cache.get(key).then(function(obj) {
                _.merge(obj[0], data);
            });
        } else {
            promise = Promise.resolve(data);
            cache.set(key, promise);
        }
    }
}

function remove(model, filter) {
    var cache = getOrCreateLRU(model, filter);
    var key = createKey(model, filter);
    cache.del(key);
}

function getLock(modelName, id) {
    var key = modelName + id;
    return lockCache[key];
}

function setLock(modelName, id, value) {
    var key = modelName + id;
    if (value === null) {
        delete lockCache[key];
    } else {
        lockCache[key] = value;
    }
}

module.exports.cache = cache;
module.exports.update = update;
module.exports.getFromCache = getFromCache;
module.exports.cacheable = cacheable;
module.exports.remove = remove;
module.exports.getLock = getLock;
module.exports.setLock = setLock;
