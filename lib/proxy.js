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

ProxyMixin.invokeProxyIfRemote = function invokeProxyIfRemote(methodName) {

    var isInstance = methodName.startsWith('prototype.');
    var model = isInstance ? this.constructor : this;

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
    var restMethod = handler.adapter.getRestMethodByName(fullName);
    if (!restMethod) {
        return false;
    }
    if (restMethod.isStatic) {
        id = getIdValue(this.constructor, this);
        ctorArgs = [id];
    }
    else if (methodName === 'findById') {
        id = args[0];
    }
    else if (methodName === 'updateById') {
        id = args[0];
    }
    else if (methodName === 'prototype.updateAttributes') {
        var data = args[0];
        id = getIdValue(model, this);
        ctorArgs = [id];
    }
    else if (methodName === 'upsert') {
        var data = args[0];
        id = getIdValue(model, data);
    }

    // id can be numeric and options.proxyModelId will be string
    // so using == 
    if (model.pluralModelName.toLowerCase() === options.evproxyModelPlural &&
        id == options.evproxyModelId) {
        return false;
    }

    // TODO url should be picked up from datasource or what?

    var invocation = new HttpInvocation(restMethod, ctorArgs, args, connection, remotes.auth);
    var req = invocation.createRequest();
    if (options.accessToken) {
        req.qs = req.qs || {};
        req.qs['access_token'] = options.accessToken;
    }
    req.headers = req.headers || {};
    var proxyKey = model.app.get('evproxyInternalKey') || '97b62fa8-2a77-458b-87dd-ef64ff67f847';
    req.headers['x-evproxy-internal-key'] = proxyKey;
    req.headers['x-evproxy-model-plural'] = model.pluralModelName.toLowerCase();
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
    }, function (err, accessRequest) {
        if (err) return callback(err);
        callback(null, accessRequest.isAllowed());
    });
};
