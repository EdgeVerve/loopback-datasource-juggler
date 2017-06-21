/**
 *
 * ©2016-2017 EdgeVerve Systems Limited (a fully owned Infosys subsidiary),
 * Bangalore, India. All Rights Reserved.
 *
 */

var LRU = require('lru-cache');
var _ = require('lodash');
var utils = require('./utils');
var Promise = require('bluebird');
var debug = require('debug')('ev:cache');
var crypto = require('crypto');
var CACHE_SIZE = 10000;
var CACHE_EXPIRATION = 0;
var allowedKeys = ['_scope','_isDeleted'];
var util = require('util');
var assert = require('assert');
var removeUndefined = utils.removeUndefined;


var instanceCache = global.instanceCache = {};
var queryCache = global.queryCache = {};

function getOrCreateLRU(model, ctx, filter) {
    var modelName = model.modelName;
    var cache;
    var cacheSize;
    var cacheExpiration;
    if (isInstanceQuery(model, ctx, filter)) {
        cache = instanceCache;
        cacheSize = model.settings.instanceCacheSize || CACHE_SIZE;
        cacheExpiration = model.settings.instanceCacheExpiration || CACHE_EXPIRATION;
    } else {
        cache = queryCache;
        cacheSize = model.settings.queryeCacheSize || CACHE_SIZE;
        cacheExpiration = model.settings.queryCacheExpiration || CACHE_EXPIRATION;
    }
    if (!cache[modelName]) {
        cache[modelName] = new LRU({
            max: cacheSize,
            maxAge: cacheExpiration,
            dispose: function (key, value) {
                debug('removing actor promise: ', key, ' from cache');
            }
        });
    }
    return cache[modelName];
}

function getFields(data, obj) {
    _.forEach(data, function dataAccessGetKeysForEach(value, key) {
        if ((typeof key === 'string') && key !== 'and' && key !== 'or') {
            obj[key] = value;
        } else if (typeof value === 'object') {
            getFields(value, obj);
        }
    });
}

function idName(m) {
    return m.definition.idName() || 'id';
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
        return null;
    }
    if (ctx.hookState.scopeVars && Object.keys(ctx.hookState.scopeVars).length !== 0) {
        return null;
    }
    var whereConds = {};
    getFields(filter.where, whereConds);
    var _isDeleted = whereConds['_isDeleted'];
    if (_isDeleted === true) {
        return null;
    }
    var pk = idName(model);
    var pkValue = whereConds[pk];
    if (pkValue !== undefined) {
        var modelAllowedKeys = [pk].concat(allowedKeys);
        var diff = _.difference(Object.keys(whereConds), modelAllowedKeys);
        if (diff.length == 0) {
            return pkValue;
        } else {
            return null;
        }
    } else {
        return null;
    }
}



function createKey(model, ctx, filter) {
    var key = isInstanceQuery(model, ctx, filter);
    if (key) {
        if (typeof key !== 'string') {
            key = JSON.stringify(key);
        }
        var scopeValue = ctx.hookState.autoscopeArray;
        if (scopeValue) {
            key += JSON.stringify(scopeValue);
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
            max: model.settings.queryeCacheSize || CACHE_SIZE,
            maxAge: model.settings.queryCacheExpiration || CACHE_EXPIRATION,
            dispose: function(key, value) {
                debug('removing actor promise: ', key, ' from cache');
            }
        });
    }
    cache = cache[modelName];
    var key = data[idName(model)];
    if(typeof key !== 'string') {
        key = key.toString();
    }
    if (data._scope) {
        key += JSON.stringify(data._scope);
    }
    var promise = cache.get(key);
    if (promise) {
        cache.get(key).then(function(obj) {
            _.assign(obj[0], data);
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

function removeById(modelName, ctx) {
    var id = ctx.id;
    var _scope = ctx.instance._scope;
    assert(id);
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
    if(typeof id !== 'string') {
        id = id.toString();
    }
    var key = id + JSON.stringify(_scope);
    cache.del(key);
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
};

CacheMixin.clearCacheOnSave = function(ctx, cb) {
    var evictInstanceCache;
    if (ctx.data || (ctx.hookState.scopeVars && Object.keys(ctx.hookState.scopeVars).length !== 0)) {
        evictInstanceCache = true;
    } else if (ctx.isNewInstance) {
        evictInstanceCache = false;
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

CacheMixin.clearCacheOnDelete = function(ctx, cb) {
    var model = ctx.Model;
    var filter = {where: ctx.where};
    var evictInstanceCache;
    if (!ctx.id) {
        evictInstanceCache = true;
    } else {
        removeById(model.modelName, ctx);
        evictInstanceCache = false;
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
module.exports.CacheMixin = CacheMixin;
