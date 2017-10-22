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

function getOrCreateLRU(model, ctx, filter, isInstanceQueryVal) {
    var modelName = model.modelName;
    var cache;
    var cacheSize;
    var cacheExpiration;
    if ( isInstanceQueryVal && !global.evDisableInstanceCache[modelName] ) {
        cache = instanceCache;
        cacheSize = model.settings.instanceCacheSize || CACHE_SIZE;
        cacheExpiration = model.settings.instanceCacheExpiration || CACHE_EXPIRATION;
    } else if (!isInstanceQueryVal){
        cache = queryCache;
        cacheSize = model.settings.queryeCacheSize || CACHE_SIZE;
        cacheExpiration = model.settings.queryCacheExpiration || CACHE_EXPIRATION;
    }
    if(!cache) {
        return null;
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
			if (obj[key]) {
				obj[key] = [].concat(obj[key],value);
			} else {
				obj[key] = value;
			}
        } else if (typeof value === 'object') {
            getFields(value, obj);
        }
    });
}

function idName(m) {
    return m.definition.idName() || 'id';
}

function hasCacheMixin(model) {
    if (model.definition && model.definition.settings && model.definition.settings.mixins && model.definition.settings.mixins.CacheMixin) {
        return true;
	}
    return false;
}

function isInstanceQuery(model, ctx, filter) {
    if (!hasCacheMixin(model)) {
        return null;
    }
    if (ctx.hookState.scopeVars && Object.keys(ctx.hookState.scopeVars).length !== 0) {
        return null;
    }
    var whereConds = {};
    getFields(filter.where, whereConds);
    var _isDeleted = whereConds._isDeleted;
    if (_isDeleted === true) {
        return null;
    }
    var pk = idName(model);
    var pkValue = whereConds[pk];
    if (pkValue !== undefined && ( typeof pkValue === 'string' || (model.getDataSource(ctx).ObjectID && pkValue instanceof model.getDataSource(ctx).ObjectID) )) {
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

function createKey(model, ctx, filter, isInstanceQueryVal) {
    if (filter.include) {
        return null;
    }
    var key = isInstanceQueryVal;
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

function clearCache(){
    global.instanceCache = {};
    global.queryCache = {};
}

function getFromCache(model, ctx, filter) {
    if (ctx.options.lockMode === 'dbLock') {
        clearCache();
        return null;
    }
    var isInstanceQueryVal = isInstanceQuery(model, ctx, filter);
    var cache = getOrCreateLRU(model, ctx, filter, isInstanceQueryVal);
    if (cache === null)
        return null;
    var key = createKey(model, ctx ,filter, isInstanceQueryVal);
    return cache.get(key);
}

function cache(model, ctx, filter, promise) {
    if (ctx.options.lockMode === 'dbLock') {
        clearCache();
        return null;
    }
    var isInstanceQueryVal = isInstanceQuery(model, ctx, filter);
    var cache = getOrCreateLRU(model, ctx, filter, isInstanceQueryVal);
    if (cache === null)
        return null;
    var key = createKey(model, ctx ,filter, isInstanceQueryVal);
    if (isInstanceQueryVal) {
        promise.then((result) => {
            if (result.length !== 0) {
                if (key) {
                    return cache.set(key, promise);
                }
            } else {
                return false;
            }
        });
    }
    else {
        if (key) {
            return cache.set(key, promise);
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

function update(ctx, data) {
     if (ctx.options.lockMode === 'dbLock') {
        clearCache();
        return null;
    }
    var model = ctx.Model;
    var modelName = model.modelName;
    if (!global.evDisableInstanceCache[modelName]){
        var cache = instanceCache;
            if (!cache[modelName]) {
                cache[modelName] = new LRU({
                    max: model.settings.instanceCacheSize || CACHE_SIZE,
                    maxAge: model.settings.instanceCacheExpiration || CACHE_EXPIRATION,
                    dispose: function(key, value) {
                        debug('removing instance promise: ', key, ' from cache');
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
}

function remove(model, ctx, filter) {
     if (ctx.options.lockMode === 'dbLock') {
        clearCache();
        return null;
    }
    var isInstanceQueryVal = isInstanceQuery(model, ctx, filter);
    var cache = getOrCreateLRU(model, ctx, filter, isInstanceQueryVal);
    if (cache === null)
        return;
    var key = createKey(model, ctx, filter, isInstanceQueryVal);
    cache.del(key);
}

function removeById(model, id, scope) {
    var modelName = model.modelName;
    assert(id);
    var cache = instanceCache;
    if (!cache[modelName]) {
        cache[modelName] = new LRU({
            max: model.settings.instanceCacheSize || CACHE_SIZE,
            maxAge: model.settings.instanceCacheExpiration || CACHE_EXPIRATION,
            dispose: function (key, value) {
                debug('removing actor promise: ', key, ' from cache');
            }
        });
    }
    cache = cache[modelName];
    if(typeof id !== 'string') {
        id = id.toString();
    }
    var key = scope ? id + JSON.stringify(scope) : id;
    cache.del(key);
}

function CacheMixin() {
}

CacheMixin.evictCache = function(evictInstanceCache, evictCtx) {
    if (!evictInstanceCache && evictCtx) {
        removeById(this, evictCtx.id, evictCtx.scope);
    }
};

CacheMixin.clearCacheOnSave = function(ctx, cb) {
    var evictInstanceCache;
    var evictCtx;
    if (ctx.data || (ctx.hookState.scopeVars && Object.keys(ctx.hookState.scopeVars).length !== 0)) {
        evictInstanceCache = true;
    } else if (ctx.isNewInstance) {
		evictCtx = {
            scope: ctx.instance._scope,
            id: ctx.instance[idName(ctx.Model)]
        };
        ctx.hookState.evictCtx = evictCtx;
        evictInstanceCache = false;
    } else if (ctx.instance) {
        update(ctx, removeUndefined(ctx.instance.toObject()));
        evictInstanceCache = false;
    } else {
        assert(false);
        return;
    }
    this.evictCache(evictInstanceCache, evictCtx);
    cb();
};


CacheMixin.clearCacheOnDelete = function(ctx, cb) {
    var model = ctx.Model;
    var filter = {where: ctx.where};
    var evictInstanceCache;
    if (!ctx.id) {
        evictInstanceCache = true;
    } else {
        removeById(model, ctx.id, ctx.instance._scope);
        evictInstanceCache = false;
    }
    this.evictCache(evictInstanceCache);
    cb();
};

module.exports.cache = cache;
module.exports.update = update;
module.exports.getFromCache = getFromCache;
module.exports.remove = remove;
module.exports.CacheMixin = CacheMixin;
