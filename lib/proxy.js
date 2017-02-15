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
    // we will keep console.log for few days till we complete
    // development of proxy remoting
    console.log('plural ', this.pluralModelName.toLowerCase(), options.proxyPlural);
    console.log('id ', id, options.proxyModelId);
    if (this.pluralModelName.toLowerCase() === options.proxyPlural &&
        toString(id) === toString(options.proxyModelId)) {
        console.log('local');
        return false;
    }
    console.log('remote');
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
