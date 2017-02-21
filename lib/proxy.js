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

// It is expected that haproxy sets evproxyModelPlural, and evproxyModelId
ProxyMixin.isRemoteInstance = function isRemoteInstance(proxyctx, options) {

    if (!proxyStarted) {
        if (options && options.evproxyPath) {
            proxyStarted = true;
        } else {
            return false;
        }
    }

    if (!this.settings.proxyEnabled) {
        return false;
    }
    console.log('check instance ', options.evproxyModelPlural, options.evproxyModelId);

    // id can be numeric and options.proxyModelId will be string
    // so using == 
    if (this.pluralModelName.toLowerCase() === options.evproxyModelPlural &&
        proxyctx.id == options.evproxyModelId) {
        return false;
    }
    return true;
}

ProxyMixin.invokeProxy = function invokeProxy(proxyctx, args, cb) {
    console.log('invokeProxy ', this.modelName, proxyctx.id);
    // TODO support proxy dataSource for each real data source
    var ds = this.app.dataSources['evproxy'];
    assert(ds, 'evproxy datasource must be present');
    this.attachTo(ds);
    var fullName = this.modelName + '.' + proxyctx.methodName;

    if (args.length > 0) {
        var options = args[args.length - 1];
        options.invokeModelPlural = this.pluralModelName.toLowerCase();
        options.invokeModelId = proxyctx.id;
    }

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


