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
