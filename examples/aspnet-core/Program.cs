using Cormier.Realtime.AspNetCore;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddDistributedMemoryCache();
builder.Services.AddSession(options =>
{
    options.Cookie.HttpOnly = true;
    options.Cookie.IsEssential = true;
    options.IdleTimeout = TimeSpan.FromMinutes(20);
});
builder.Services.AddRealtimeGateway(builder.Configuration);

var app = builder.Build();
app.UseRealtimeGateway();
app.UseSession();
app.MapRealtimeGateway();
app.MapGet("/", () => Results.Text("Cormier.Realtime ASP.NET Core integration example"));
app.Run();
