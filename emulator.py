
import asyncio
from meta import PARAMETERS_META
from models import Device, Parameter


async def spawn_errors():
    device,_ = await Device.get_or_create(tag="AMS_1", name="Насосная станция", model="AMS PCP 1S12")
    await device.save()
    print("asas")
    await device.fetch_related("parameters")

    params = {x.parameter: x for x in device.parameters}
    meta = PARAMETERS_META[device.model]

    for m in meta.values():
        if m.parameter not in params:
            params[m.parameter] = Parameter(
                device=device, 
                parameter = m.parameter, 
                value = 0
            )
        params[m.parameter].value = m.norm or m.minimum_warning or m.maximum_warning
        await params[m.parameter].save()


    async def too_low(p: str):
        while params[p].value >= meta[p].minimum - meta[p].minimum / 5:
            params[p].value -= meta[p].minimum / 5
            await params[p].save()
            await asyncio.sleep(1)
        await asyncio.sleep(2)
        
    
    async def too_high(p: str):
        while params[p].value <= meta[p].maximum + meta[p].maximum / 5:
            params[p].value += meta[p].maximum  / 5
            await params[p].save()
            await asyncio.sleep(1)
        await asyncio.sleep(2)
    
    async def is_normal(p: str):
        if meta[p].minimum is not None:
            while params[p].value <= meta[p].minimum + meta[p].minimum / 5:
                params[p].value += meta[p].minimum  / 5
                await params[p].save()
                await asyncio.sleep(1)
        if meta[p].maximum is not None:
            while params[p].value >= meta[p].maximum - meta[p].maximum / 5:
                params[p].value -= meta[p].maximum / 5
                await params[p].save()
                await asyncio.sleep(1)
        await asyncio.sleep(2)
    

    await asyncio.gather(too_high("Вибрация широкополосная"), too_high("Температура вала"), is_normal("Ток вала"))

    await asyncio.gather(too_high("Вибрация широкополосная"), too_low("Давление на входе"))

    await asyncio.gather(too_high("Вибрация на удвоенной частоте"), too_high("Ток вала"), is_normal("Температура вала"))

    await asyncio.gather(too_low("КПД проточной части"), is_normal("Вибрация широкополосная"),
                          is_normal("Температура вала"))

    await too_high("Наработка насоса")

    # TODO
    await asyncio.gather(too_high("Вибрация подшипникового узла"), too_high("Температура подшипникового узла"))


    #TODO
    await asyncio.gather(too_high("Вибрация низкочастотная"))

    await asyncio.gather(too_low("Уровень масла"), too_high("Температура подшипникового узла"))

    await asyncio.gather(too_high("Дисбаланс токов по фазам"), too_high("Температура клеммной коробки"))