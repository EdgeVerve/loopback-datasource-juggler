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
var QUERY_CACHE_SIZE = 10000;
var INSTANCE_CACHE_SIZE = 10000;
var QUERY_CACHE_EXPIRATION = 1000;
var INSTANCE_CACHE_EXPIRATION = 0;
var allowedKeys = ['_scope','_isDeleted','_autoscope'];
var util = require('util');
var assert = require('assert');
var config = require('../../../server/config');
var removeUndefined = utils.removeUndefined;


var instanceCache = global.instanceCache = {};
var queryCache = global.queryCache = {};
var dbLockStartTime = 0;
var dbLockDuration = config.dbLockDuration;

function getOrCreateLRU(model, ctx, filter, isInstanceQueryVal) {
    var modelName = model.modelName;
    var cache;
    var cacheSize;
    var cacheExpiration;
    if ( isInstanceQueryVal && !global.evDisableInstanceCache[modelName] ) {
        cache = instanceCache;
        cacheSize = model.settings.instanceCacheSize || INSTANCE_CACHE_SIZE;
        cacheExpiration = model.settings.instanceCacheExpiration || INSTANCE_CACHE_EXPIRATION;
    } else if (!isInstanceQueryVal){
        cache = queryCache;
        cacheSize = model.settings.queryeCacheSize || QUERY_CACHE_SIZE;
        cacheExpiration = model.settings.queryCacheExpiration || QUERY_CACHE_EXPIRATION;
    }
    if(!cache) {
        return null;
    }
    if (!cache[modelName]) {
        cache[modelName] = new LRU({
            max: cacheSize,
            maxAge: cacheExpiration,
            dispose: function (key, value) {
                debug('removing instance promise: ', key, ' from cache');
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
    var _isDeleted = whereConds['_isDeleted'];
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

global.setDBLockMode = function() {
    dbLockStartTime = Date.now();
    dbLockDuration = config.dbLockDuration;
    clearCache();
}

global.eraseCache = function() {
    dbLockDuration = 0;
    clearCache();
}

global.inDBLockMode = function() {
    if (Date.now() - dbLockStartTime < dbLockDuration) {
        return true;
    }
   return false;
}

function getFromCache(model, ctx, filter, cb) {
    if (global.inDBLockMode()) {
        return cb(null);
    }
    var isInstanceQueryVal = isInstanceQuery(model, ctx, filter);
    if (!isInstanceQueryVal && ctx.options.noQueryCache) {
        return cb(null);
    }
    if (isInstanceQueryVal && ctx.options.noInstanceCache) {
        return cb(null);
    }
    var cache = getOrCreateLRU(model, ctx, filter, isInstanceQueryVal, cb);
    if (cache === null)
        return cb(null);
    var key = createKey(model, ctx ,filter, isInstanceQueryVal);
    var valueFromCache = cache.get(key);
    if (!valueFromCache) {
        return cb(null);
    }
    if (valueFromCache instanceof Promise) {
        valueFromCache.then((objs) => {
            if (isInstanceQueryVal) {
                if (objs.length !== 0) {
                    cb(objs);
                } else {
                    cache.del(key);
                    cb(null);
                }
            } else {
                cb(objs);
            }
        }).catch((err) => {
            cb(err);
        });
    } else {
        if (isInstanceQueryVal) {
            if (valueFromCache.length !== 0) {
                return cb (valueFromCache);
            } else {
                cache.del(key);
                return cb(null);
            }
        }
        return cb(valueFromCache);
    }
}

function cache(model, ctx, filter, valToCache) {
    if (global.inDBLockMode()) {
        return null;
    }
    var isInstanceQueryVal = isInstanceQuery(model, ctx, filter);
    var cache = getOrCreateLRU(model, ctx, filter, isInstanceQueryVal);
    if (cache === null)
        return null;
    var key = createKey(model, ctx ,filter, isInstanceQueryVal);
    if (key) {
        return cache.set(key, valToCache);
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
    if (global.inDBLockMode()) {
        return null;
    }
    var model = ctx.Model;
    var modelName = model.modelName;
    if (!global.evDisableInstanceCache[modelName]){
        var cache = instanceCache;
            if (!cache[modelName]) {
                cache[modelName] = new LRU({
                    max: model.settings.instanceCacheSize || INSTANCE_CACHE_SIZE,
                    maxAge: model.settings.instanceCacheExpiration || INSTANCE_CACHE_EXPIRATION,
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
            // if (data._autoscope) {
            //     key += JSON.stringify(data._autoscope);
            // }
            var cachedVal = cache.get(key);
            if (cachedVal) {
                if (cachedVal instanceof Promise) {
                    cache.get(key).then(function(obj) {
                        obj = [data];
                        cache.set(key, [data]);
                    });
                } else {
                    cache.set(key, [data]);
                }
            } else {
                cache.set(key, [data]);
            }
    }
}

function remove(model, ctx, filter) {
    if (global.inDBLockMode()) {
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
    if (cache[modelName]) {
        cache = cache[modelName];
        if(typeof id !== 'string') {
            id = id.toString();
        }
        var key = scope ? id + JSON.stringify(scope) : id;
        // key+=autoscope ? JSON.stringify(autoscope) : '';
        cache.del(key);
    }
}

function CacheMixin() {
}

CacheMixin.clearCacheOnSave = function(ctx, cb) {
    if (ctx.hookState.scopeVars && Object.keys(ctx.hookState.scopeVars).length !== 0) {
        return cb();
    }
    else if (ctx.data) {
        // console.log('-----No Id in update----');
    } else if (ctx.isNewInstance) {
        return cb();
    } else if (ctx.instance) {
        update(ctx, removeUndefined(ctx.instance.toObject()));
    }
    cb();
};

CacheMixin.clearCacheOnDelete = function(ctx, cb) {
    var model = ctx.Model;
    var filter = {where: ctx.where};
    if (!ctx.id) {
        // console.log('-----No Id in delete----');
    } else {
        removeById(model, ctx.id, ctx.instance._scope);
    }
    cb();
};

module.exports.cache = cache;
module.exports.update = update;
module.exports.getFromCache = getFromCache;
module.exports.remove = remove;
module.exports.CacheMixin = CacheMixin;
