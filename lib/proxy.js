/*!
 * Dependencies
 */
var assert = require('assert');
var HttpInvocation = require('strong-remoting/lib/http-invocation');
var ContextBase = require('strong-remoting/lib/context-base');
var HttpContext = require('strong-remoting/lib/http-context');
var logger = require('oe-logger');
var log = logger('juggler/proxy');
var RestAdapter = require('strong-remoting/lib/rest-adapter');


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

    var connection = model.app.get('evproxyurl');
    if (!connection) {
        return false;
    }
    if (!model.settings.proxyEnabled) {
        return false;
    }
	
    var args = Array.prototype.slice.call(arguments);
    assert(args.length > 2, 'invalid arguments');

    var options = args[args.length - 2];
    if (!proxyStarted) {
        if (options && options.evproxyPath) {
            proxyStarted = true;
        } else {
            return false;
        }
    }

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
        ctorArgs = [id];
    } else if (methodName === 'upsert') {
        var data = args[0];
        id = getIdValue(model, data);
    } else {
        if (restMethod.sharedMethod.isStatic === false) {
            id = getIdValue(model, this);
            ctorArgs = [id];
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
                        ctorArgs = [id];
                        break;
                    default:
                        id = args[proxyIdSource];
                        assert(id != 'undefined', 'Id value not found');
                        ctorArgs = [id];
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
                    ctorArgs = id ? [id] : [args[0]];
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
    if (model.pluralModelName.toLowerCase() === options.evproxyModelPlural &&
        id == options.evproxyModelId) {
        return false;
    }
		log.debug(log.defaultContext(), 'invoke proxy ', model.pluralModelName, id);
    
    // TODO url should be picked up from datasource or what?

    var invocation = new HttpInvocation(restMethod, ctorArgs, args, connection, remotes.auth);
    var req = invocation.createRequest();
    if (options.accessToken) {
        req.qs = req.qs || {};
        req.qs['access_token'] = options.accessToken;
    }
		req.forever = true;
		req.pool = localpool;
    req.headers = req.headers || {};
    var proxyKey = model.app.get('evproxyInternalKey') || '97b62fa8-2a77-458b-87dd-ef64ff67f847';
    req.headers['x-evproxy-internal-key'] = proxyKey;
    req.headers['x-evproxy-model-plural'] = model.pluralModelName.toLowerCase();
    req.headers['x-evproxy-model-id'] = id;
    var callContextHeader = Buffer.from(JSON.stringify(options), 'utf8').toString('base64');
    req.headers['x-evproxy-context'] = callContextHeader;
    var self = this;
    invocation.invoke(function(err) {
				log.debug(options, 'proxy response received. ', err ? err : ': no error ');
	      if (err) { return callback(err); }
        var args = Array.prototype.slice.call(arguments);
        var res = invocation.getResponse();
        callback.apply(self, args);
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