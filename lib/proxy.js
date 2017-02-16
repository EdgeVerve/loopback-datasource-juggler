/*!
 * Dependencies
 */
var assert = require('assert');

module.exports = ProxyMixin;

var proxyStarted = false;

/**
 * RelationMixin class.  Use to define relationships between models.
 *
 * @class RelationMixin
 */
function ProxyMixin() {

}

ProxyMixin.isRemoteCall = function isRemoteCall(methodname, args, options, cb) {

    var id = args;

    if (Array.isArray(args) || args === Array) {
        id = args[0];
    }

    if (!proxyStarted) {
        if (options.proxyPath) {
            proxyStarted = true;
        } else {
            return false;
        }
    }

    if (!this.settings.proxyEnabled) {
        return false;
    }
    // id can be numeric and options.proxyModelId will be string
    // so using == 
    if (this.pluralModelName.toLowerCase() === options.proxyPlural &&
        id == options.proxyModelId) {
        return false;
    }
    return true;
}

ProxyMixin.invokeProxy = function invokeProxy(methodName, args, cb) {
    // TODO support proxy dataSource for each real data source
    var ds = this.app.dataSources['evproxy'];
    assert(ds, 'evproxy datasource must be present');
    this.attachTo(ds);
    var fullName = this.modelName + '.' + methodName;
    ds.connector.remotes.invoke(fullName, args, cb);
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

    var proxyKey = this.app.get('evproxyKey');
    if (ctx.req && ctx.req.headers && proxyKey) {
        if (ctx.req.headers['x-evproxy'] === proxyKey) {
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


