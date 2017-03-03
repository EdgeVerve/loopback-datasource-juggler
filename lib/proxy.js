/*!
 * Dependencies
 */
var assert = require('assert');
var HttpInvocation = require('strong-remoting/lib/http-invocation');
var ContextBase = require('strong-remoting/lib/context-base');
var HttpContext = require('strong-remoting/lib/http-context');

module.exports = ProxyMixin;

var proxyStarted = false;

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

ProxyMixin.invokeProxyIfRemote = function invokeProxyIfRemote() {

    if (!this.settings.proxyEnabled) {
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

    var methodName = args[0];
    var fullName = this.modelName + "." + methodName;
    var remotes = this.app.remotes();
    var handler = this.app.handler('rest');
    var restMethod = handler.adapter.getRestMethodByName(fullName);

    if (!restMethod) {
        return false;
    }

    args.shift();
    var id;

    // for now hard code based on method
    if (methodName === 'findById') {
        id = args[0];
    } else if (methodName === 'updateAttributes' || methodName === 'upsert') {
        var data = args[0];
        id = getIdValue(this, data);
    }

    // id can be numeric and options.proxyModelId will be string
    // so using == 
    if (this.pluralModelName.toLowerCase() === options.evproxyModelPlural &&
        id == options.evproxyModelId) {
        return false;
    }

    var ctorArgs;
    if (restMethod.isStatic) {
        ctorArgs = [getIdValue(this.constructor, this)];
    }

    var connection = 'http://localhost:8080/api';
    var invocation = new HttpInvocation(restMethod, ctorArgs, args, connection, remotes.auth);
    var req = invocation.createRequest();
    if (options.accessToken) {
        req.qs = req.qs || {};
        req.qs['access_token'] = options.accessToken;
    }
    req.headers = req.headers || {};
    req.headers['x-evproxy-model-plural'] = this.pluralModelName.toLowerCase();
    req.headers['x-evproxy-model-id'] = id;
    var callContextHeader = Buffer.from(JSON.stringify(options), 'utf8').toString('base64');
    req.headers['x-evproxy-context'] = callContextHeader;
    var self = this;
    invocation.invoke(function (err) {
        if (err) { return callback(err); }
        var args = Array.prototype.slice.call(arguments);
        var res = invocation.getResponse();
        callback.apply(self, args);
    });

    return true;

};

ProxyMixin.checkAccess = function (token, modelId, sharedMethod, ctx, callback) {

    var ANONYMOUS = this.app.registry.getModel('AccessToken').ANONYMOUS;
    token = token || ANONYMOUS;
    var aclModel = this._ACL();

    ctx = ctx || {};
    if (typeof ctx === 'function' && callback === undefined) {
        callback = ctx;
        ctx = {};
    }

    // Do not check ACL if it is node to node communication
    var proxyKey = this.app.get('evproxyInternalKey');
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
    }, function (err, accessRequest) {
        if (err) return callback(err);
        callback(null, accessRequest.isAllowed());
    });
};


