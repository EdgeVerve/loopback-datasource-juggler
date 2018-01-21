/*!
 * Dependencies
 */

  /**
 *
 * ©2016-2018 EdgeVerve Systems Limited (a fully owned Infosys subsidiary),
 * Bangalore, India. All Rights Reserved.
 *
 */

var assert = require('assert');
var HttpInvocation = require('strong-remoting/lib/http-invocation');
var ContextBase = require('strong-remoting/lib/context-base');
var HttpContext = require('strong-remoting/lib/http-context');
var logger = require('oe-logger');
var log = logger('juggler/proxy');
var RestAdapter = require('strong-remoting/lib/rest-adapter');
var Dynamic = require('strong-remoting/lib//dynamic');

module.exports = ProxyMixin;

var proxyStarted = false;
var localpool = {
	maxSockets: 10
};
var restClasses = {};

/**
 * RelationMixin class.  Use to define relationships between models.
 *
 * @class RelationMixin
 */
function ProxyMixin() {

}

function idName(m) {
    return m.definition.idName() || 'id';
}

function getIdValue(m, data) {
    return data && data[idName(m)];
}

ProxyMixin.invokeProxyIfRemote = function invokeProxyIfRemote(methodName) {

    //var isInstance = methodName.startsWith('prototype.');
    //var model = isInstance ? this.constructor : this;
    var model = typeof(this) === 'function' ? this : Object.getPrototypeOf(this).constructor;
    var socket = model.app.get('oe-tx-router');
    if (!socket) {
        return false;
    }

    if (!socket.connected) {
        // TODO try reconnect with promise like db connection
        return false;
    }

    if (!model.settings.proxyEnabled) {
        return false;
    }

    var args = Array.prototype.slice.call(arguments);
    assert(args.length > 2, 'invalid arguments');

    var options = args[args.length - 2];


    var lastArgIsFunc = typeof args[args.length - 1] === 'function';
    var callback;
    if (lastArgIsFunc) {
        callback = args.pop();
    } else {
        callback = utils.createPromiseCallback();
    }

    var remotes = model.app.remotes();
    var handler = model.app.handler('rest');

    var fullName = model.modelName + "." + methodName;

    args.shift();
    var id;

    var ctorArgs;
    var restMethod;
		var restClass = restClasses[model.modelName];
		if (!restClass) {
			restClass = new RestAdapter.RestClass(model.sharedClass);
			restClasses[model.modelName] = restClass;
		}
		for (var j = 0; j < restClass.methods.length; j++) {
			var method = restClass.methods[j];
			if (method.name === methodName) {
				restMethod = method;
			}
		}
 		if (!restMethod) {
	 			log.error(log.defaultContext(), ' restMethod not found ', fullName);
				return false;
		}
	  if (methodName === 'findById') {
        id = args[0];
    } else if (methodName === 'updateById') {
        id = args[0];
    } else if (methodName === 'prototype.updateAttributes') {
        id = getIdValue(model, this);
        ctorArgs = {id:id}
    } else if (methodName === 'upsert') {
        var data = args[0];
        id = getIdValue(model, data);
    } else {
        if (restMethod.sharedMethod.isStatic === false) {
            id = getIdValue(model, this);
            ctorArgs = {id:id}
        } else {
            var settings = this.settings.proxyMethods && this.settings.proxyMethods.find(m => m.name === methodName);
            if (settings) {
                var proxyIdSource = settings.idSource || 0;
                var proxyIdName = settings.idName;

                switch (proxyIdSource) {
                    case 'body':
                        var data = args[0];
                        if (proxyIdName) {
                            id = data[proxyIdName];
                        } else {
                            id = getIdValue(this, data);
                        }
                        assert(id != 'undefined', 'Id value not found');
                        ctorArgs = {id:id}
                        break;
                    default:
                        id = args[proxyIdSource];
                        assert(id != 'undefined', 'Id value not found');
                        ctorArgs = {id:id}
                        break;
                }
            } else {
                //as execution reached here,
                //we asume that the function is proxy enabled remote method
                //but not configured as one in model's .json
                //this may happen when
                //invokeProxyIfRemote is called manually (not injected as part of model config)
                //get data from body args[0]
                var data = args[0];
                id = getIdValue(this, data);
                //if id value is undefined (in body),
                //then get id value from default 0 index of args
                if (id || (args[0] && args[0] != 'function' && args[0] != 'object')) {
                    ctorArgs = {id: id ? id : args[0] }
                } else {
                    //no id value found to proceed,
                    assert(ctorArgs != 'undefined', 'Id value not found, please configure proxy method in model\'s .json file ');
                    return false;
                }
            }
        }
    }

		// id can be numeric and options.proxyModelId will be string
    // so using ==
    if (model.clientPlural.toLowerCase() === options.evproxyModelPlural &&
        id == options.evproxyModelId) {
            log.debug('Processing myself ----->', model.modelName + '/' + id)
        return false;
    }
    log.debug(log.defaultContext(), 'invoke proxy ', model.pluralModelName, id);

    var namedArgs ={};
    restMethod.accepts.forEach(function(item, i){
        namedArgs[item.arg] = args[i];
    });

    var data = {
        fullMethodName : fullName,
        modelPlural : model.clientPlural.toLowerCase(),
        modelName: model.modelName,
        id : id,
        ctorArgs : ctorArgs,
        args : namedArgs,
        callContextHeader : options
    };

    var ctx = {
        method: restMethod
    };

    var self = this;

    var c = socket;

    log.debug('Forwarding request to ----->', model.modelName + '/' + id)

    c.transieve(data, function(stateResponse) {
        log.debug('Received Response from Remote ->', model.modelName + '/' + id)
        // convert stateResponse to args
        var argsArray = [stateResponse.error];
        // similar to buildArgs..
        var result = stateResponse.result;
        var returns = restMethod.returns;
        for (var i = 0, n = returns.length; i < n; i++) {
            var ret = returns[i];
            var name = ret.name || ret.arg;
            var val;
            var dynamic;
            var type = ret.type;

            if (ret.root) {
                val = result;
            } else {
                val = result ? result[name] : null;
            }
            if (typeof type === 'string' && Dynamic.canConvert(type)) {
              dynamic = new Dynamic(val, ctx);
              val = dynamic.to(type);
            } else if (Array.isArray(type) && Dynamic.canConvert(type[0])) {
              type = type[0];
              for (var j = 0, k = val.length; j < k; j++) {
                var _val = val[j];
                dynamic = new Dynamic(_val, ctx);
                val[j] = dynamic.to(type);
              }
            }
            argsArray.push(val);
          }
          callback.apply(self, argsArray);

      });

    return true;

};

ProxyMixin.checkAccess = function(token, modelId, sharedMethod, ctx, callback) {

    var ANONYMOUS = this.app.registry.getModel('AccessToken').ANONYMOUS;
    token = token || ANONYMOUS;
    var aclModel = this._ACL();

    ctx = ctx || {};
    if (typeof ctx === 'function' && callback === undefined) {
        callback = ctx;
        ctx = {};
    }

    // Do not check ACL if it is node to node communication
    var proxyKey = this.app.get('evproxyInternalKey') || '97b62fa8-2a77-458b-87dd-ef64ff67f847';
    if (ctx.req && ctx.req.headers && proxyKey) {
        if (ctx.req.headers['x-evproxy-internal-key'] === proxyKey) {
            return callback(null, 'ALLOW');
        }
    }

    // Do not check ACL if Model definition settings has a property "bypassACL" set to true.
    if (this.definition && this.definition.settings && this.definition.settings.bypassACL
        && (this.definition.settings.bypassACL.toString() === 'true')) {
        return callback(null, true);
    }

    aclModel.checkAccessForContext({
        accessToken: token,
        model: this,
        property: sharedMethod.name,
        method: sharedMethod.name,
        sharedMethod: sharedMethod,
        modelId: modelId,
        accessType: this._getAccessTypeForMethod(sharedMethod),
        remotingContext: ctx
    }, function(err, accessRequest) {
        if (err) return callback(err);
        callback(null, accessRequest.isAllowed());
    });
};
