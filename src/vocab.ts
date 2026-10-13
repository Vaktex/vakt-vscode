/** Versioned, intentionally conservative vocabulary shared with the server. */
export const VOCAB_VERSION: number = 1;

/** Lower-case words only. Product/customer names must not be added here. */
export const VOCAB: ReadonlySet<string> = new Set(`
abstract async await as assert break case catch class const constructor continue debugger
 default def defer delete do else enum export extends false final finally for from function
 get global goto if implements import in instanceof interface is lambda let local match
 namespace new nil none nonlocal not null of or override package pass private protected
 public raise readonly require return self set static struct super switch then this throw
 throws trait true try type typeof undefined union use using var virtual void volatile
 when where while with yield end and each begin until repeat fn impl mut pub mod crate
 string number boolean bool int integer float double decimal bigint byte char bytes
 array object map set list dict tuple record vector promise result optional any unknown
 never error exception date time datetime timestamp json xml html text binary buffer
 value values key keys name names id ids index count length size data body content input
 output item items entry entries field fields property properties param params args options
 config context ctx result results response request req res event events callback handler
 handle create read update remove insert select query execute exec find filter sort reduce
 join split replace trim parse stringify encode decode serialize deserialize format valid
 validate validation check test tests spec mock fixture expect equal equals ok success fail
 failure status message messages log logger debug info warn warning fatal trace error errors
 client server service controller model view route routes router endpoint api http https
 method headers header cookie cookies session sessions origin host hostname port url uri
 path paths file files directory dir filename basename extension stream open close write
 readfile writefile mkdir unlink fs process env argv command commands shell spawn child
 stdin stdout stderr exit code signal socket fetch post put patch head delete get send
 redirect render template escape unescape sanitized sanitize unsafe safe raw untrusted
 auth authenticate authentication authorization authorize authorized login logout signin
 signout signup user users account accounts admin role roles permission permissions access
 token tokens secret secrets password passwords credential credentials bearer basic csrf
 cors xss sql injection security secure encrypt decrypt encryption crypto hash digest md5
 sha sha256 sha512 hmac salt nonce random uuid jwt verify signature signed certificate tls
 ssl public private rsa aes key secretkey apikey accesskey clientsecret passwordhash
 database db connection connect transaction commit rollback table tables column columns
 row rows sql select from where and or order by group limit offset having union all distinct
 into values update insert delete drop alter create grant revoke null not exists like
 prepared prepare statement statements bind parameter parameters pool prisma drizzle
 sequelize mongoose redis cache cached store storage getitem setitem localstorage
 stripe payment payments charge charges checkout invoice invoices customer customers
 subscription subscriptions webhook webhooks refund refunds amount currency balance price
 product products plan plans billing credit debit total subtotal tax quantity receipt
 express fastify koa hono next nuxt svelte sveltekit react vue angular django flask rails
 laravel spring dotnet asp net node npm bun deno python javascript typescript java rust
 go ruby php c cpp csharp swift kotlin lua bash sh powershell perl scala elixir erlang
 src lib server client app apps pages page layout components component public static
 assets styles css scss sass less js jsx ts tsx mjs cjs json yaml yml toml ini env config
 settings index main utils util helpers helper middleware services controllers models
 views routes api auth payments admin data files security ui test tests tooling docs
 dist build out target bin scripts tools vendor packages node_modules migrations schema
 graphql gql sql html htm svelte vue md txt lock git github gitignore docker dockerfile
 readme license manifest package lock spec d mts cts woff woff2 svg png jpg jpeg gif webp
 pdf zip gz tar mp4 ico wasm map import export default page layout server error loading
 action actions loader dynamic slug params rest optional group locale language version
 utf ascii base64 hex charset encoding decodeuricomponent encodeuricomponent console
 math floor ceil round min max abs stringify parseint parsefloat isarray isfinite isnan
 prototype tostring hasownproperty defineproperty entries assign resolve reject then catch
 finally add has includes startswith endswith match search push pop shift unshift slice
 splice concat foreach tostring trimstart trimend touppercase tolowercase document window
 location navigator div span button form label email address phone first last username
 authenticated unauthorized forbidden notfound statuscode timeout retry retries abort
 enabled disabled active pending completed expires expiry expiration expiresat createdat
 updatedat deletedat userid accountid customerid requestid contenttype application accept
 content length type authorization x forward forwarded ip localhost multipart formdata
 selectall inner left right outer join on asc desc count sum average avg foreign primary
 unique constraint references cascade regexp regex pattern flags source destination
`.split(/\s+/).filter(Boolean));
