var LRU = require('lru-cache');
var _ = require('lodash');
var utils = require('./utils');
var Promise = require('bluebird');
var debug = require('debug')('ev:cache');
var crypto = require('crypto');
var CACHE_SIZE = 1000;
var allowedKeys = ['_scope','_isDeleted'];
var util = require('util');
var removeUndefined = utils.removeUndefined;

var instanceCache = global.instanceCache = {};
var queryCache = global.queryCache = {};
var lockCache = {};

function getOrCreateLRU(model, ctx, filter) {
    var modelName = model.modelName;
    var cache;
    if (isInstanceQuery(model, ctx, filter)) {
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

function isInstanceQuery(model, ctx, filter) {
    if (!inhertisFromBaseEntity(model)) {
        return false;
    }
    if (ctx.options.scopeVars && Object.keys(ctx.options.scopeVars).length !== 0) {
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



function createKey(model, ctx, filter) {
    var key;
    if (isInstanceQuery(model, ctx, filter)) {
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

function getFromCache(model, ctx, filter) {
    var cache = getOrCreateLRU(model, ctx, filter);
    var key = createKey(model, ctx ,filter);
    return cache.get(key);
}

function cache(model, ctx, filter, promise) {
    var cache = getOrCreateLRU(model, ctx, filter);
    var key = createKey(model, ctx ,filter);
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

function update(ctx, data) {
    var model = ctx.Model;
    var modelName = model.modelName;
    var cache = instanceCache;
    if (!cache[modelName]) {
        cache[modelName] = new LRU({
            max: CACHE_SIZE,
            dispose: function (key, value) {
                debug('removing actor promise: ', key, ' from cache');
            }
        });
    }
    cache = cache[modelName];
    var key = JSON.stringify(data[idName(model)]);
    if (data['_scope']) {
        key += JSON.stringify(data['_scope']);
    }
    var promise = cache.get(key);
    if (promise) {
        cache.get(key).then(function(obj) {
            _.merge(obj[0], data);
        });
    } else {
        if  (Array.isArray(data)) {
            promise = Promise.resolve(data);
        } else {
            promise = Promise.resolve([data]);
        }
        cache.set(key, promise);
    }
}

function remove(model, ctx, filter) {
    var cache = getOrCreateLRU(model, ctx, filter);
    var key = createKey(model, ctx, filter);
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

function evict(modelName, evictInstanceCache) {
    delete queryCache[modelName];
    if(evictInstanceCache) {
        delete instanceCache[modelName];
    }
}

function CacheMixin() {
}

CacheMixin.evictCache = function(evictInstanceCache) {
    evict(this.modelName, evictInstanceCache);
}

CacheMixin.clearCache = function(ctx, cb) {
    var evictInstanceCache;
    if (ctx.data || (ctx.options.scopeVars && Object.keys(ctx.options.scopeVars).length !== 0)) {
        evictInstanceCache = true;
    } else if (ctx.instance) {
        update(ctx, removeUndefined(ctx.instance.toObject()));
        evictInstanceCache = false;
    } else {
        assert(false);
        return;
    }
    this.evictCache(evictInstanceCache);
    ctx.Model.notifyObserversOf('after cache', ctx, function (err) {
        cb(err);
    });
};

module.exports.cache = cache;
module.exports.update = update;
module.exports.getFromCache = getFromCache;
module.exports.remove = remove;
module.exports.getLock = getLock;
module.exports.setLock = setLock;
module.exports.CacheMixin = CacheMixin;
